@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title Amharic Captions - Windows Runtime Verification

set "ROOT=%~dp0"
set "RT=%ROOT%com.amharic.captions\runtime"
set "PY=%RT%\python\python.exe"
set "FF=%RT%\bin\ffmpeg.exe"
set "MD=%RT%\model"
set "TMPW=%TEMP%\amh_verify_test.wav"
set "DEGRADED=0"
if exist "%ROOT%DEGRADED_BUILD.txt" set "DEGRADED=1"

set /a PASS=0
set /a FAIL=0

echo =================================================================
echo   Amharic Captions - Windows Runtime Verification
echo =================================================================
echo   Installation root : %ROOT%
echo   Runtime           : %RT%
echo.

call :check "python.exe present"      exist "%PY%"
call :check "python311.dll present"   exist "%RT%\python\python311.dll"
call :check "ffmpeg.exe present"      exist "%FF%"
rem Lite package: the model is not in the zip. Use the downloaded copy if
rem there is one; otherwise say so instead of failing.
set "LITE_NOMODEL=0"
if not exist "%MD%\model.bin" if exist "%RT%\model_manifest.json" call :resolve_model
if "%LITE_NOMODEL%"=="1" (
  echo   [INFO] Lite package: the Amharic model downloads on first use.
  echo          Model checks are skipped until it has been downloaded.
) else (
  call :check "model.bin present"       exist "%MD%\model.bin"
  call :check "model_meta.json present" exist "%MD%\model_meta.json"
  call :check "vocab.json present"       exist "%MD%\vocab.json"
  call :check "config.json present"     exist "%MD%\config.json"
)
if "%DEGRADED%"=="0" (
  call :check "speaker_embed.onnx present"    exist "%RT%\speaker_embed.onnx"
  call :check "silero_vad.onnx present"       exist "%RT%\silero_vad.onnx"
  call :check "amh_lm.json.gz present"       exist "%RT%\amh_lm.json.gz"
) else (
  echo [WARN] Explicit degraded test build: optional ML feature checks skipped.
)

if "%FAIL%"=="0" call :check "ctranslate2, numpy, soundfile imports" pyimport
if "%FAIL%"=="0" if "%DEGRADED%"=="0" call :check "onnxruntime VAD import" pyimportort
if "%FAIL%"=="0" if "%DEGRADED%"=="0" call :check "sherpa_onnx diarization import" pyimportsherpa
if "%FAIL%"=="0" if "%LITE_NOMODEL%"=="0" call :check "CTranslate2 model loads + warm" pymodel
if "%FAIL%"=="0" call :check "ffmpeg runs - version" ffmpeg

if exist "%TMPW%" del "%TMPW%" >nul 2>&1

echo.
echo =================================================================
if "%FAIL%"=="0" (
  echo   RESULT: ALL CHECKS PASSED - %PASS%/%PASS% checks - runtime is healthy.
  echo =================================================================
  exit /b 0
) else (
  echo   RESULT: %FAIL% CHECKS FAILED - see messages above.
  echo   Fix the filesystem locations listed and re-run this script.
  echo =================================================================
  exit /b 1
)

:resolve_model
set "MD="
for /f "usebackq delims=" %%P in (`""%PY%" -E "%RT%\amh_model.py" path"`) do set "MD=%%P"
if not defined MD set "LITE_NOMODEL=1"
if defined MD echo   [INFO] Using the downloaded model: %MD%
exit /b 0

:check
  set "name=%~1"
  set "kind=%~2"
  if "%kind%"=="exist" (
    if exist "%~3" (
      echo   [PASS] %name%
      set /a PASS+=1
    ) else (
      echo   [FAIL] %name%  - NOT FOUND: %~3
      set /a FAIL+=1
    )
    exit /b 0
  )
  if "%kind%"=="pyimport" (
    "%PY%" -E -c "import numpy, soundfile, ctranslate2; print('numpy', numpy.__version__); print('soundfile', soundfile.__version__); print('ctranslate2', ctranslate2.__version__)" >nul 2>&1
    if errorlevel 1 (
      echo   [FAIL] %name%
      "%PY%" -E -c "import numpy, soundfile, ctranslate2"
      set /a FAIL+=1
    ) else (
      echo   [PASS] %name%
      set /a PASS+=1
    )
    exit /b 0
  )
  if "%kind%"=="pyimportort" (
    "%PY%" -E -c "import onnxruntime as ort; print('onnxruntime', ort.__version__)" >nul 2>&1
    if errorlevel 1 (
      echo   [FAIL] %name%
      "%PY%" -E -c "import onnxruntime"
      set /a FAIL+=1
    ) else (
      echo   [PASS] %name%
      set /a PASS+=1
    )
    exit /b 0
  )
  if "%kind%"=="pyimportsherpa" (
    "%PY%" -E -c "import sherpa_onnx; print('sherpa_onnx', sherpa_onnx.__version__)" >nul 2>&1
    if errorlevel 1 (
      echo   [FAIL] %name%
      "%PY%" -E -c "import sherpa_onnx"
      set /a FAIL+=1
    ) else (
      echo   [PASS] %name%
      set /a PASS+=1
    )
    exit /b 0
  )
  if "%kind%"=="pymodel" (
    rem Paths travel via the ENVIRONMENT, not string interpolation: embedding
    rem %RT%/%MD% inside the -c literal would corrupt on ' or non-ASCII chars.
    set "AMH_RT=%RT%"
    set "AMH_MD=%MD%"
    "%PY%" -E -c "import json, os, sys; rt=os.environ['AMH_RT']; md=os.environ['AMH_MD']; sys.path.insert(0, rt); import numpy as np, ctranslate2 as ct; m = ct.models.Wav2Vec2Bert(md, device='cpu', compute_type='int8'); from amh_mel import MelExtractor; MelExtractor(md); v = json.load(open(os.path.join(md, 'vocab.json'), encoding='utf-8')); assert len(v) >= 100, 'small vocab'; print('model+mel+vocab OK, vocab size', len(v))" >nul 2>&1
    if errorlevel 1 (
      echo   [FAIL] %name%
      "%PY%" -E -c "import os, sys; sys.path.insert(0, os.environ['AMH_RT']); import ctranslate2 as ct; ct.models.Wav2Vec2Bert(os.environ['AMH_MD'], device='cpu', compute_type='int8')"
      set /a FAIL+=1
    ) else (
      echo   [PASS] %name%
      set /a PASS+=1
    )
    exit /b 0
  )
  if "%kind%"=="ffmpeg" (
    "%FF%" -hide_banner -version >nul 2>&1
    if errorlevel 1 (
      echo   [FAIL] %name%
      set /a FAIL+=1
    ) else (
      echo   [PASS] %name%
      set /a PASS+=1
    )
    exit /b 0
  )
exit /b 0

endlocal