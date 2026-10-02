@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem ============================================================
rem  Amharic Captions Pro - Repair (Windows)
rem ============================================================
rem
rem  Fixes the most common "DLL load failed" / numpy crash, which
rem  happens when a security app (antivirus) quarantines a compiled
rem  engine file, or when the download was blocked / not fully
rem  unzipped. It is safe to run any time and changes nothing about
rem  your captions, license, or settings. It:
rem    - clears the "downloaded from the internet" block on every
rem      installed file (no administrator rights needed), and
rem    - adds an antivirus (Windows Defender) exclusion for the
rem      Adobe extensions folder (needs administrator rights), and
rem    - checks that the transcription engine can start, and tells
rem      you the exact next step if it still cannot.
rem
rem  Just double-click it. For the antivirus exclusion step, right-
rem  click and choose "Run as administrator" (optional).
rem
rem  Keep this file ASCII-only with no exclamation marks in echoed
rem  text (delayed expansion is on) and save it with Windows (CRLF)
rem  line endings, exactly like Install.cmd.
rem ============================================================

rem Window-keeping bootstrap: if double-clicked, relaunch under
rem "cmd /k" so the window stays open at the end instead of flashing.
if /I "%~1"=="/keepopen" goto :main
cmd /k call "%~f0" /keepopen
exit /b 0

:main
title Amharic Captions Pro - Repair
color 07

set "NAME=com.amharic.captions"
set "EXTBASE=%APPDATA%\Adobe\CEP\extensions"
set "EXT=%EXTBASE%\%NAME%"
set "PYEXE=%EXT%\runtime\python\python.exe"
set "LOG=%TEMP%\amharic-captions-repair.log"

> "%LOG%" echo ================================================
>> "%LOG%" echo Amharic Captions Repair
>> "%LOG%" echo Start: %date% %time%
>> "%LOG%" echo User:  %USERNAME%
>> "%LOG%" echo Extension: "%EXT%"

echo.
echo ================================================================
echo     AMHARIC CAPTIONS PRO  -  REPAIR
echo ================================================================
echo.

if not exist "%EXT%\CSXS\manifest.xml" (
    color 0E
    echo   The extension is not installed yet, so there is nothing to
    echo   repair. Please run Install.cmd from the folder you unzipped,
    echo   then open this Repair tool only if a problem appears.
    echo.
    >> "%LOG%" echo ERROR: extension not found at "%EXT%"
    echo   Press any key to close this window.
    pause >nul
    exit /b 1
)

rem ------------------------------------------------------------
rem 1. Clear the Mark-of-the-Web block. A DLL that Windows marks as
rem    "downloaded from the internet" fails to load with the same
rem    error as an antivirus deletion. Unblock-File needs no admin.
rem ------------------------------------------------------------
echo   [1/3] Clearing download blocks on the installed files...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath $env:EXT -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue" >> "%LOG%" 2>&1
>> "%LOG%" echo [OK] Unblock-File pass complete.

rem ------------------------------------------------------------
rem 2. Add an antivirus (Windows Defender) exclusion so it stops
rem    removing engine files. Needs admin; if we do not have it we
rem    say how to finish this one step by hand.
rem ------------------------------------------------------------
echo   [2/3] Adding an antivirus exclusion for the extensions folder...
net session >nul 2>&1
if errorlevel 1 goto :no_admin
powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-MpPreference -ExclusionPath $env:EXTBASE -ErrorAction SilentlyContinue" >> "%LOG%" 2>&1
echo         Done - Windows Defender will no longer remove these files.
>> "%LOG%" echo [OK] Added Defender exclusion for "%EXTBASE%"
goto :smoke

:no_admin
echo         Skipped - this needs administrator rights. To do it, close
echo         this window, right-click Repair.cmd and choose
echo         "Run as administrator". If you use a different antivirus
echo         (not Windows Defender), add this folder to its exclusions:
echo           "%EXTBASE%"
>> "%LOG%" echo INFO: not elevated; Defender exclusion skipped

:smoke
rem ------------------------------------------------------------
rem 3. Smoke test: can the engine actually start now?
rem    -E ignores PYTHON* env vars so this reflects the bundle.
rem ------------------------------------------------------------
echo   [3/3] Checking that the transcription engine can start...
if not exist "%PYEXE%" goto :noengine
"%PYEXE%" -E -c "import numpy, ctranslate2, soundfile" >> "%LOG%" 2>&1
if errorlevel 1 goto :stillbad

color 0A
echo.
echo ================================================================
echo     REPAIR SUCCESSFUL  -  the engine starts correctly
echo ================================================================
echo.
echo   Fully quit Premiere Pro or After Effects with  File, Exit, then
echo   reopen it and make your captions. If you added the antivirus
echo   exclusion, this should not happen again.
echo.
>> "%LOG%" echo [OK] Engine import smoke test passed.
echo   Press any key to close this window.
pause >nul
exit /b 0

:noengine
color 0E
echo.
echo   The Python engine file is missing from your install:
echo     "%PYEXE%"
echo   Your antivirus most likely removed it. Please add the exclusion
echo   above, then delete the extension folder, re-extract the zip you
echo   downloaded (right-click the zip, Properties, Unblock first), and
echo   run Install.cmd again.
echo.
>> "%LOG%" echo ERROR: python.exe missing after repair
echo   Send this log to @AmharicCaptionsBot on Telegram if it repeats:
echo     %LOG%
echo.
echo   Press any key to close this window.
pause >nul
exit /b 2

:stillbad
color 0E
echo.
echo ================================================================
echo     ONE MORE STEP NEEDED
echo ================================================================
echo.
echo   The engine still cannot start, so a file is blocked or missing.
echo   Please do this - it takes about a minute:
echo.
echo     1. Make sure the antivirus exclusion above was added (run this
echo        Repair.cmd as administrator if it was skipped).
echo     2. Delete the extension folder:
echo          "%EXT%"
echo     3. Right-click the zip you downloaded, Properties, Unblock, OK.
echo     4. Extract the zip again and run Install.cmd one more time.
echo.
>> "%LOG%" echo WARNING: engine import still failing after repair
echo   Need help? Send this log to @AmharicCaptionsBot on Telegram:
echo     %LOG%
echo.
echo   Press any key to close this window.
pause >nul
exit /b 3
