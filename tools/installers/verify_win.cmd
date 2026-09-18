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
call :check "model.bin present"       exist "%MD%\model.bin"
call :check "model_meta.json present" exist "%MD%\model_meta.json"
call :check "vocabulary.json present" exist "%MD%\vocabulary.json"
call :check "config.json present"     exist "%MD%\config.json"
call :check "speaker_embed.onnx present"    exist "%RT%\speaker_embed.onnx"
call :check "silero_vad.onnx present"       exist "%RT%\silero_vad.onnx"
call :check "amh_lm.json.gz present"  exist "%RT%\amh_lm.json.gz"

if "%FAIL%"=="0" (
  call :check "ctranslate2, numpy, soundfile imports" pyimport
  call :check "onnxruntime (VAD) import"             pyimportort
  call :check "sherpa_onnx (diarization) import"     pyimportsherpa
  call :check "CTranslate2 model loads + warm"       pymodel
  call :check "ffmpeg runs (version)"               ffmpeg
)

if exist "%TMPW%" del "%TMPW%" >nul 2>&1

echo.
echo =================================================================
if "%FAIL%"=="0" (
  echo   RESULT: ALL CHECKS PASSED (%PASS%/%PASS%)  - runtime is healthy.
  echo =================================================================
  exit /b 0
) else (
  echo   RESULT: %FAIL% CHECK(S) FAILED - see messages above.
  echo   Fix the filesystem locations listed and re-run this script.
  echo =================================================================
  exit /b 1
)

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
    cd /d "%RT%"
    "%PY%" -E -c "import json, os, sys; sys.path.insert(0, r'%RT%'); import numpy as np, ctranslate2 as ct; m = ct.models.Wav2Vec2Bert(r'%MD%', device='cpu', compute_type='int8'); from amh_mel import MelExtractor; MelExtractor(r'%MD%'); v = json.load(open(os.path.join(r'%MD%','vocab.json'))); assert len(v) >= 100, 'small vocab'; print('model+mel+vocab OK, vocab size', len(v))" >nul 2>&1
    if errorlevel 1 (
      echo   [FAIL] %name%
      "%PY%" -E -c "import sys; sys.path.insert(0, r'%RT%'); import ctranslate2 as ct; m = ct.models.Wav2Vec2Bert(r'%MD%', device='cpu', compute_type='int8')"
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