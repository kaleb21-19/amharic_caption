# build_win.ps1
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

# model — prefer the CTranslate2 INT8 model (tools/stage/model-ct2-int8),
# fall back to fp16/fp32. Never ships torch at runtime.
$ModelSrc = Join-Path $STAGE "model-ct2-int8"
if (Test-Path (Join-Path $ModelSrc "model_meta.json")) {
    Write-Host "  [model] CTranslate2 int8"
} elseif (Test-Path (Join-Path $STAGE "model-fp16\config.json")) {
    $ModelSrc = Join-Path $STAGE "model-fp16"
    Write-Host "  [model] fp16 source"
} else {
    $ModelSrc = Join-Path $ROOT "ethio-asr"
    Write-Host "  [model] fp32 source"
}
Copy-Item $ModelSrc (Join-Path $BNAME "runtime\model") -Recurse

# scripts
Copy-Item "$ROOT\ethio_srt.py" (Join-Path $BNAME "runtime\ethio_srt.py")
Copy-Item "$ROOT\amh_mel.py" (Join-Path $BNAME "runtime\amh_mel.py")

# ffmpeg + python
Copy-Item $FF (Join-Path $BNAME "runtime\bin\ffmpeg.exe")
Copy-Item $PYDIR (Join-Path $BNAME "runtime\python") -Recurse

# shared panel
Copy-Item "$ROOT\panel\*" $BNAME -Recurse

# ---- 4. zip ----------------------------------------------------------------
$ZIP = Join-Path $ROOT "dist\amharic-captions-$TARGET.zip"
New-Item -ItemType Directory -Force -Path (Join-Path $ROOT "dist") | Out-Null
if (Test-Path $ZIP) { Remove-Item -Force $ZIP }

if (Get-Command 7z -ErrorAction SilentlyContinue) {
    Push-Location $BUILD; 7z a -tzip -r $ZIP "com.amharic.captions" -xr!".DS_Store"; Pop-Location
} else {
    Compress-Archive -Path (Join-Path $BNAME) -DestinationPath $ZIP -CompressionLevel Optimal
}
Remove-Item -Recurse -Force $BUILD
Write-Host "== wrote $ZIP =="
