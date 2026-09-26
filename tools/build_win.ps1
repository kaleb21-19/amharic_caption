# build_win.ps1
param(
    [switch]$AllowDegraded,
    # -Lite: leave the model out of the zip (~540 MB smaller). The panel and the
    # SRT maker download it once, resumably, from -ModelSource (see
    # tools/MODEL_HOSTING.md). Without -Lite the model is bundled as before.
    [switch]$Lite,
    [string[]]$ModelSource = @()
)
#
# Windows assemble + zip step (equivalent of tools/build.sh for win-x64).
#
# First prepare the relocatable runtime ON Windows under Git-Bash / WSL:
#   bash tools/prepare_python.sh
# (this fetches a relocatable CPython + ctranslate2/numpy/soundfile + ffmpeg.exe
# into tools/stage/win-x64)
#
# Then assemble + zip here:
#   powershell -ExecutionPolicy Bypass -File tools\build_win.ps1
#
# Steps:
#   1. verify Windows x64
#   2. copy the staged relocatable python/ + ffmpeg.exe
#   3. copy the CT2 int8 model + ethio_srt.py + amh_mel.py into runtime/
#   4. copy the shared panel/ + zip into dist/
#
# Requires: 7-Zip or tar for zipping (built-in tar works on Win10+).

$ErrorActionPreference = "Stop"
$ROOT   = $PSScriptRoot | Split-Path -Parent   # project root (parent of tools)
$STAGE  = Join-Path $ROOT "tools\stage"
$TARGET = "win-x64"
$TGT    = Join-Path $STAGE $TARGET

# ---- 1. verify windows x64 ------------------------------------------------
Write-Host "== assembling zip for target: $TARGET =="
if ($env:PROCESSOR_ARCHITECTURE -in @("AMD64","x86_64")) {
    Write-Host "  [ok] Windows x64 detected"
} else {
    Write-Host "  [FAIL] unsupported arch: $env:PROCESSOR_ARCHITECTURE (need x64)"; exit 1
}

# ---- 2. staged python + ffmpeg --------------------------------------------
$PYDIR = Join-Path $TGT "python"
if (-not (Test-Path (Join-Path $PYDIR "python.exe"))) {
    Write-Host "  [FAIL] staged relocatable python not found. Run: bash tools/prepare_python.sh"; exit 1
}
$FF = Join-Path $TGT "ffmpeg.exe"
if (-not (Test-Path $FF)) {
    Write-Host "  [FAIL] staged ffmpeg.exe not found. Run: bash tools/prepare_python.sh"; exit 1
}

# ---- 3. assemble -----------------------------------------------------------
$BUILD  = Join-Path $env:TEMP "amh_build_$([guid]::NewGuid().ToString('N'))"
$BNAME  = Join-Path $BUILD "com.amharic.captions"
New-Item -ItemType Directory -Force -Path (Join-Path $BNAME "runtime\bin") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $BNAME "runtime\python") | Out-Null
if ($AllowDegraded) {
    Set-Content -Path (Join-Path $BUILD "DEGRADED_BUILD.txt") -Value "LOCAL/TEST DEGRADED BUILD - optional ML assets may be absent; NOT FOR RELEASE."
}

# model - prefer the CTranslate2 INT8 model (tools/stage/model-ct2-int8),
# fall back to fp16/fp32. Never ships torch at runtime.
$ModelSrc = Join-Path $STAGE "model-ct2-int8"
if (Test-Path (Join-Path $ModelSrc "model_meta.json")) {
    Write-Host "  [model] CTranslate2 int8"
} elseif ($AllowDegraded -and (Test-Path (Join-Path $STAGE "model-fp16\config.json"))) {
    $ModelSrc = Join-Path $STAGE "model-fp16"
    Write-Host "  [model] fp16 source (degraded build)"
} elseif ($AllowDegraded -and (Test-Path (Join-Path $ROOT "ethio-asr\config.json"))) {
    $ModelSrc = Join-Path $ROOT "ethio-asr"
    Write-Host "  [model] fp32 source (degraded build)"
} else {
    Write-Host "  [FAIL] production CTranslate2 int8 model is missing"; exit 1
}
# Model lock: never package an unapproved model by accident (a stale local
# conversion once replaced the approved Hohe model: 47% vs 34% WER).
$LockFile = Join-Path $ROOT "tools\model.lock"
$ModelBin = Join-Path $ModelSrc "model.bin"
if ((Test-Path $LockFile) -and (Test-Path $ModelBin)) {
    $want = (Get-Content $LockFile | Where-Object { $_ -match '^[0-9a-f]{64}$' } | Select-Object -First 1)
    $have = (Get-FileHash -Algorithm SHA256 $ModelBin).Hash.ToLower()
    if ($want -and $have -ne $want) {
        if (-not $AllowDegraded) {
            Write-Host "  [FAIL] staged model.bin is not the approved model in tools\model.lock"
            Write-Host "         have $have"
            Write-Host "         want $want"
            exit 1
        }
        Write-Host "  [warn] unapproved model.bin (degraded build only)"
    } else {
        Write-Host "  [ok] model.bin matches tools\model.lock"
    }
}
if ($Lite -and $ModelSource.Count -eq 0) {
    Write-Host "  [FAIL] -Lite needs at least one -ModelSource URL (where customers download the model)"; exit 1
}
if (-not $Lite) {
    Copy-Item $ModelSrc (Join-Path $BNAME "runtime\model") -Recurse
} else {
    Write-Host "  [lite] model NOT bundled; downloaded on first use from: $($ModelSource -join ', ')"
}
# Model manifest (sizes + SHA-256 + download sources) in every build: lite
# downloads from it, full uses it to spot a stale carried-forward model.
if (Test-Path (Join-Path $ModelSrc "model.bin")) {   # degraded fp16/fp32 builds have none
    $ManifestArgs = @("$ROOT\tools\make_model_manifest.py", $ModelSrc, "--out", (Join-Path $BNAME "runtime\model_manifest.json"))
    foreach ($s in $ModelSource) { $ManifestArgs += @("--source", $s) }
    & (Join-Path $PYDIR "python.exe") @ManifestArgs
    if ($LASTEXITCODE -ne 0) { Write-Host "  [FAIL] could not write model_manifest.json"; exit 1 }
}

# scripts
Copy-Item "$ROOT\ethio_srt.py" (Join-Path $BNAME "runtime\ethio_srt.py")
Copy-Item "$ROOT\amh_mel.py" (Join-Path $BNAME "runtime\amh_mel.py")
Copy-Item "$ROOT\ctc_beam.py" (Join-Path $BNAME "runtime\ctc_beam.py")
Copy-Item "$ROOT\amh_correct.py" (Join-Path $BNAME "runtime\amh_correct.py")
# Standalone SRT maker (no Premiere/After Effects needed) + shared licensing.
Copy-Item "$ROOT\amh_license.py" (Join-Path $BNAME "runtime\amh_license.py")
Copy-Item "$ROOT\amh_standalone.py" (Join-Path $BNAME "runtime\amh_standalone.py")
Copy-Item "$ROOT\amh_model.py" (Join-Path $BNAME "runtime\amh_model.py")

# 2-speaker diarization (interview labels). Omitted only if the model file
# hasn't been fetched (bash tools/embed/fetch_model.sh) - verified by
# verify_win.cmd.
if (Test-Path "$ROOT\tools\embed\nemo_en_titanet_small.onnx") {
    Copy-Item "$ROOT\amh_diarize.py" (Join-Path $BNAME "runtime\amh_diarize.py")
    Copy-Item "$ROOT\tools\embed\nemo_en_titanet_small.onnx" (Join-Path $BNAME "runtime\speaker_embed.onnx")
    Write-Host "  [ok] amh_diarize.py + speaker_embed.onnx"
} else {
    if (-not $AllowDegraded) { Write-Host "  [FAIL] speaker embedding model missing (use -AllowDegraded only for a non-release build)"; exit 1 }
    Write-Host "  [warn] tools\embed\nemo_en_titanet_small.onnx missing - speaker labels disabled"
}

# Amharic word-LM (glue-word resegmentation). Built offline by tools/build_lm.py.
if (Test-Path "$ROOT\tools\lm\amh_lm.json.gz") {
    Copy-Item "$ROOT\amh_lm.py" (Join-Path $BNAME "runtime\amh_lm.py")
    Copy-Item "$ROOT\tools\lm\amh_lm.json.gz" (Join-Path $BNAME "runtime\amh_lm.json.gz")
    Write-Host "  [ok] amh_lm.py + amh_lm.json.gz"
} else {
    if (-not $AllowDegraded) { Write-Host "  [FAIL] Amharic word-LM missing (use -AllowDegraded only for a non-release build)"; exit 1 }
    Write-Host "  [warn] tools\lm\amh_lm.json.gz missing - word-LM disabled"
}

# Silero VAD (onnx) - speech-gap detector. Omitted if tools/vad/silero_vad.onnx
# hasn't been staged; ethio_srt.py then degrades to whole-clip transcribing.
if (Test-Path "$ROOT\tools\vad\silero_vad.onnx") {
    Copy-Item "$ROOT\tools\vad\silero_vad.onnx" (Join-Path $BNAME "runtime\silero_vad.onnx")
    Copy-Item "$ROOT\amh_vad.py" (Join-Path $BNAME "runtime\amh_vad.py")
    Write-Host "  [ok] silero_vad.onnx + amh_vad.py"
} else {
    if (-not $AllowDegraded) { Write-Host "  [FAIL] Silero VAD model missing (use -AllowDegraded only for a non-release build)"; exit 1 }
    Write-Host "  [warn] tools\vad\silero_vad.onnx missing - VAD disabled (whole-clip transcribe)"
}

# ffmpeg + python
Copy-Item $FF (Join-Path $BNAME "runtime\bin\ffmpeg.exe")
# NOTE: must copy the CONTENTS of $PYDIR (trailing `\*`), NOT the dir itself.
# Copy-Item -Recurse of a dir into a pre-created target dir nests it as
# runtime\python\python\... so the panel's runtime check fails on Windows.
Copy-Item (Join-Path $PYDIR "*") (Join-Path $BNAME "runtime\python") -Recurse

# ---- 3a. trim the bundled Python to runtime-only files ---------------------
# Mirrors tools/build.sh step 1b, plus Windows/pip extras that are never
# imported at runtime:
#   include/ libs/ Scripts/   headers, import libs, console shims (Scripts\
#                             also held duplicate onnxruntime/sherpa DLLs;
#                             sherpa_onnx\lib\ carries the ones it loads)
#   tcl/, tkinter, idlelib, turtle*, ensurepip, venv, lib2to3, pydoc_data, test
#   _test*.pyd                CPython's own C test modules
#   sympy, mpmath             onnxruntime install deps, unused for inference
#   site-packages tests dirs  package self-tests (numpy.testing is kept)
$PYOUT = Join-Path $BNAME "runtime\python"
$LIBR  = Join-Path $PYOUT "Lib"
$SITE  = Join-Path $LIBR "site-packages"
$Trim = @(
    (Join-Path $PYOUT "include"), (Join-Path $PYOUT "libs"), (Join-Path $PYOUT "Scripts"),
    (Join-Path $PYOUT "tcl"),
    (Join-Path $LIBR "ensurepip"), (Join-Path $LIBR "idlelib"), (Join-Path $LIBR "lib2to3"),
    (Join-Path $LIBR "pydoc_data"), (Join-Path $LIBR "tkinter"), (Join-Path $LIBR "turtledemo"),
    (Join-Path $LIBR "venv"), (Join-Path $LIBR "test"), (Join-Path $LIBR "turtle.py"),
    (Join-Path $SITE "sympy"), (Join-Path $SITE "mpmath"), (Join-Path $SITE "isympy.py"),
    (Join-Path $SITE "__pycache__\isympy.cpython-311.pyc"), (Join-Path $PYOUT "share")
)
foreach ($p in $Trim) { if (Test-Path $p) { Remove-Item -Recurse -Force $p } }
Get-ChildItem (Join-Path $PYOUT "DLLs") -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^(_tkinter\.pyd|tcl.*\.dll|tk.*\.dll|_test.*\.pyd|_ctypes_test\.pyd)$' } |
    Remove-Item -Force
Get-ChildItem $SITE -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^(sympy|mpmath)-.*\.dist-info$' } |
    Remove-Item -Recurse -Force
Get-ChildItem $SITE -Directory -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -in @('tests', 'testdata') } |
    Sort-Object { $_.FullName.Length } -Descending |
    ForEach-Object { if (Test-Path $_.FullName) { Remove-Item -Recurse -Force $_.FullName } }
Get-ChildItem (Join-Path $SITE "sherpa_onnx\lib") -Filter *.lib -ErrorAction SilentlyContinue | Remove-Item -Force
Write-Host "  [ok] python trimmed"

# shared panel (developer tests are not shipped to customers)
Copy-Item "$ROOT\panel\*" $BNAME -Recurse
$PanelTests = Join-Path $BNAME "test"
if (Test-Path $PanelTests) { Remove-Item -Recurse -Force $PanelTests }

# one-click installer (shipped at zip root, next to the extension folder)
$INST = Join-Path $ROOT "tools\installers"

function Assert-CrlOnly([string]$Path, [string]$What) {
    $raw = [System.IO.File]::ReadAllBytes($Path)
    $bareLf = 0; $bareCr = 0; $i = 0
    while ($i -lt $raw.Length) {
        if ($raw[$i] -eq 13 -and $i + 1 -lt $raw.Length -and $raw[$i+1] -eq 10) {
            $i += 2; continue                                      # valid CRLF pair
        }
        if ($raw[$i] -eq 13) { $bareCr++ } elseif ($raw[$i] -eq 10) { $bareLf++ }
        elseif ($raw[$i] -lt 32 -and $raw[$i] -ne 9) {
            # A stray control byte (e.g. an escaped "\a" that became BEL) turns a
            # path like runtime\amh_... into garbage that cmd passes on silently.
            Write-Host "  [FAIL] $What contains control byte 0x$('{0:X2}' -f $raw[$i]) at offset $i."
            exit 1
        }
        $i++
    }
    if ($bareLf -gt 0 -or $bareCr -gt 0) {
        Write-Host "  [FAIL] $What has $bareLf LF and $bareCr bare-CR ending(s); cmd.exe will mis-parse it ('.. was unexpected at this time'). Fix the endings (git attr: *.cmd text eol=crlf)."
        exit 1
    }
    Write-Host "  [ok] $What (CRLF validated)"
}

Assert-CrlOnly (Join-Path $INST "Install.cmd")    "Install.cmd"
Copy-Item (Join-Path $INST "Install.cmd") (Join-Path $BUILD "Install.cmd")
Assert-CrlOnly (Join-Path $INST "Make Amharic Captions.cmd") "Make Amharic Captions.cmd"
# Inside the extension folder, so Install.cmd's copy carries it and the
# desktop shortcut can point at the installed runtime.
Copy-Item -LiteralPath (Join-Path $INST "Make Amharic Captions.cmd") (Join-Path $BNAME "Make Amharic Captions.cmd")
Assert-CrlOnly (Join-Path $INST "verify_win.cmd") "verify_win.cmd"
Copy-Item (Join-Path $INST "verify_win.cmd") (Join-Path $BUILD "verify_win.cmd")
Copy-Item (Join-Path $INST "VERIFY.md")          (Join-Path $BUILD "VERIFY.md")
Write-Host "  [ok] verify_win.cmd + VERIFY.md (windows runtime verification harness)"

# ---- 3b. licences + third-party notices ------------------------------------
# Mirrors tools/build.sh step 2c. The bundled ffmpeg.exe is a GPL build, so the
# licence text and the written offer for corresponding source MUST accompany
# it. Shipped at the zip ROOT, beside Install.cmd.
$LICSRC = Join-Path $ROOT "tools\licenses"
$LICDST = Join-Path $BUILD "licenses"
New-Item -ItemType Directory -Force -Path $LICDST | Out-Null
foreach ($f in @("COPYING.GPLv2.txt", "COPYING.GPLv3.txt", "COPYING.LGPLv2.1.txt", "WRITTEN-OFFER.txt")) {
    Copy-Item (Join-Path $LICSRC $f) (Join-Path $LICDST $f)
}
# Generated from the staged artefacts, so the notice always describes the
# ffmpeg actually in this zip. Hard-fails on a nonfree binary.
# Use the staged, relocatable interpreter rather than PATH. On Windows,
# `Get-Command python` can resolve the Microsoft Store shim, which exits
# without running Python and used to make notice generation fail after the
# runtime had already been assembled.
$pyPath = Join-Path $PYDIR "python.exe"
if (-not (Test-Path $pyPath)) {
    $py = Get-Command py.exe -ErrorAction SilentlyContinue
    if (-not $py) { $py = Get-Command python.exe -ErrorAction SilentlyContinue }
    if (-not $py) { Write-Host "  [FAIL] no usable Python interpreter; cannot generate THIRD-PARTY-NOTICES.md"; exit 1 }
    $pyPath = $py.Source
}
& $pyPath (Join-Path $LICSRC "gen_notices.py") `
    --ffmpeg  (Join-Path $BNAME "runtime\bin\ffmpeg.exe") `
    --runtime (Join-Path $BNAME "runtime") `
    --target  $TARGET `
    --out     (Join-Path $LICDST "THIRD-PARTY-NOTICES.md")
if ($LASTEXITCODE -ne 0) { Write-Host "  [FAIL] gen_notices.py failed"; exit 1 }
Write-Host "  [ok] licenses/ (GPL text + written offer + third-party notices)"

# User-facing legal documents must travel with every platform archive, not
# only inside the extension folder. Keep them at the ZIP root beside Install.cmd.
$LEGAL = Join-Path $ROOT "tools\legal"
foreach ($f in @("EULA.txt", "PRIVACY.txt", "REFUND.txt")) {
    $src = Join-Path $LEGAL $f
    if (-not (Test-Path $src)) { Write-Host "  [FAIL] missing legal document: $src"; exit 1 }
    Copy-Item $src (Join-Path $BUILD $f)
}
Write-Host "  [ok] EULA.txt + PRIVACY.txt + REFUND.txt at zip root"

# ---- 4. zip ----------------------------------------------------------------
$ZIP = Join-Path $ROOT ("dist\amharic-captions-$TARGET" + $(if ($Lite) { "-lite" } else { "" }) + ".zip")
New-Item -ItemType Directory -Force -Path (Join-Path $ROOT "dist") | Out-Null
if (Test-Path $ZIP) { Remove-Item -Force $ZIP }

$ZipEntries = @("com.amharic.captions", "licenses", "Install.cmd", "verify_win.cmd", "VERIFY.md", "EULA.txt", "PRIVACY.txt", "REFUND.txt")
if (Test-Path (Join-Path $BUILD "DEGRADED_BUILD.txt")) { $ZipEntries += "DEGRADED_BUILD.txt" }
# Never 7z: GitHub's hosted runner may expose a 7z command that exits without
# producing the requested archive (the job then reported a ZIP that was not on
# disk). Prefer Windows' built-in bsdtar (Win10 1803+): unlike Windows
# PowerShell 5.1's Compress-Archive it writes spec-compliant forward-slash entry
# names. Compress-Archive with retries remains the fallback; the size check
# below catches a missing archive either way.
$zipped = $false
if (Test-Path "$env:SystemRoot\System32\tar.exe") {
    Push-Location $BUILD
    & "$env:SystemRoot\System32\tar.exe" -a -c -f $ZIP @ZipEntries
    $tarExit = $LASTEXITCODE
    Pop-Location
    if ($tarExit -eq 0) { $zipped = $true } else { Write-Host "  [warn] tar.exe zip failed ($tarExit); falling back to Compress-Archive" }
}
if (-not $zipped) {
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            if (Test-Path $ZIP) { Remove-Item -Force $ZIP -ErrorAction SilentlyContinue }
            Compress-Archive -Path ($ZipEntries | ForEach-Object { Join-Path $BUILD $_ }) -DestinationPath $ZIP -CompressionLevel Optimal
            break
        } catch {
            if ($attempt -eq 5) { throw }
            Start-Sleep -Seconds (2 * $attempt)
        }
    }
}
if (-not (Test-Path -LiteralPath $ZIP) -or (Get-Item -LiteralPath $ZIP).Length -le 0) {
    throw "compression produced no usable archive: $ZIP"
}
Remove-Item -Recurse -Force $BUILD
Write-Host "== wrote $ZIP =="
