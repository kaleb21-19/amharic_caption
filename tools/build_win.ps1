# build_win.ps1
#
# Windows-native build for the win-x64 target. Run this ON a Windows x64
# machine from a PowerShell window in the project root.
#
#   powershell -ExecutionPolicy Bypass -File tools\build_win.ps1
#
# Steps:
#   1. detect/verify Windows x64
#   2. build a Python venv + ML deps (torch/transformers/soundfile/numpy)
#   3. prune unused packages (scipy, sklearn, numba, llvmlite, torchaudio)
#   4. fetch a static ffmpeg.exe
#   5. verify imports
#   6. copy the shared panel/ + assemble runtime/ + zip into dist/
#
# Requires: Python 3.11 on PATH (the "py" launcher), 7-Zip or tar for zipping.

$ErrorActionPreference = "Stop"
$ROOT   = $PSScriptRoot | Split-Path -Parent   # project root (parent of tools)
$STAGE  = Join-Path $ROOT "tools\stage"
$TARGET = "win-x64"
$TGT    = Join-Path $STAGE $TARGET

Write-Host "== preparing runtime for target: $TARGET =="
New-Item -ItemType Directory -Force -Path $TGT | Out-Null
$PYDIR = Join-Path $TGT "python"

# ---- 1. verify windows x64 ------------------------------------------------
if ($env:PROCESSOR_ARCHITECTURE -in @("AMD64","x86_64")) {
    Write-Host "  [ok] Windows x64 detected"
} else {
    Write-Host "  [FAIL] unsupported arch: $env:PROCESSOR_ARCHITECTURE (need x64)"; exit 1
}

# ---- 2. python venv + deps ------------------------------------------------
Write-Host "  [step] creating python venv + installing deps (downloads ~1GB)"
if (Test-Path $PYDIR) { Remove-Item -Recurse -Force $PYDIR }
# Prefer an explicit Python on PATH (e.g. CI setup-python), else the py launcher.
if (Get-Command python -ErrorAction SilentlyContinue) { $pycmd = "python" }
elseif (Get-Command py -ErrorAction SilentlyContinue) { $pycmd = "py" }
else { Write-Host "  [FAIL] no Python found (install it and put python/py on PATH)"; exit 1 }

if ($pycmd -eq "py") {
    Invoke-Expression "py -3 -m venv `"$PYDIR`""
} else {
    & $pycmd -m venv "$PYDIR"
}
$PY = Join-Path $PYDIR "Scripts\python.exe"
& $PY -m pip install --quiet --upgrade pip
& $PY -m pip install --quiet torch transformers soundfile numpy
Write-Host "  [ok] deps installed"

# ---- 3. prune unused packages ---------------------------------------------
$SP = Join-Path $PYDIR "Lib\site-packages"
$prunable = @("scipy","sklearn","numba","llvmlite","torchaudio")
foreach ($pkg in $prunable) {
    Get-ChildItem -Path $SP -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq $pkg -or ($_.Name -like "$pkg-*.dist-info") -or ($_.Name -like "$pkg-*") } |
        ForEach-Object { Remove-Item -Recurse -Force $_.FullName }
}
# REMOVE scikit-learn (dir is 'sklearn', dist-info scikit_learn-*)
Get-ChildItem -Path $SP -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "scikit*" } |
    ForEach-Object { Remove-Item -Recurse -Force $_.FullName }
Write-Host "  [ok] pruned unused packages"
# NOTE: sympy/mpmath/networkx are KEPT — torch.fx (used by transformers) needs them.

# ---- 4. static ffmpeg.exe --------------------------------------------------
$FF = Join-Path $TGT "ffmpeg.exe"
if (-not (Test-Path $FF)) {
    Write-Host "  [step] downloading static ffmpeg (BtbN gpl builds)"
    $zip = Join-Path $env:TEMP "ffmpeg-win.zip"
    Invoke-WebRequest -Uri "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip" -OutFile $zip
    $tmp = Join-Path $env:TEMP "ffmpeg-unpack"
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $exe = Get-ChildItem $tmp -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
    Copy-Item $exe.FullName $FF
    Remove-Item -Recurse -Force $tmp, $zip
}
Write-Host "  [ok] ffmpeg ($( (Get-Item $FF).Length / 1MB ) MB)"

# ---- 5. verify imports ------------------------------------------------------
Write-Host "  [step] verifying imports"
& $PY -c "import torch, transformers, soundfile, numpy; print('   core imports OK')"

# ---- 6. assemble + zip ------------------------------------------------------
Write-Host "== assembling zip =="
$BUILD  = Join-Path $env:TEMP "amh_build_$([guid]::NewGuid().ToString('N'))"
$BNAME  = Join-Path $BUILD "com.amharic.captions"
New-Item -ItemType Directory -Force -Path (Join-Path $BNAME "runtime\bin") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $BNAME "runtime\python") | Out-Null

# model — prefer the fp16 half-size model (tools/stage/model-fp16), fall back
# to the fp32 ethio-asr/. The runtime applies .half() either way.
$ModelSrc = Join-Path $STAGE "model-fp16"
if (-not (Test-Path (Join-Path $ModelSrc "config.json"))) {
    $ModelSrc = Join-Path $ROOT "ethio-asr"
    Write-Host "  [model] fp32 source"
} else {
    Write-Host "  [model] fp16 source"
}
Copy-Item $ModelSrc (Join-Path $BNAME "runtime\model") -Recurse
# script
Copy-Item "$ROOT\ethio_srt.py" (Join-Path $BNAME "runtime\ethio_srt.py")
# ffmpeg
Copy-Item $FF (Join-Path $BNAME "runtime\bin\ffmpeg.exe")
# python
Copy-Item $PYDIR (Join-Path $BNAME "runtime\python") -Recurse
# shared panel
Copy-Item "$ROOT\panel\*" $BNAME -Recurse

$ZIP = Join-Path $ROOT "dist\amharic-captions-$TARGET.zip"
New-Item -ItemType Directory -Force -Path (Join-Path $ROOT "dist") | Out-Null
if (Test-Path $ZIP) { Remove-Item -Force $ZIP }

# prefer 7z if present, else Tar (built in on Win10+)
if (Get-Command 7z -ErrorAction SilentlyContinue) {
    Push-Location $BUILD; 7z a -tzip -r $ZIP "com.amharic.captions" -xr!".DS_Store"; Pop-Location
} else {
    # Tar in Windows extracts/creates zip better; use Compress-Archive fallback
    Compress-Archive -Path (Join-Path $BNAME) -DestinationPath $ZIP -CompressionLevel Optimal
}
Remove-Item -Recurse -Force $BUILD
Write-Host "== wrote $ZIP =="
