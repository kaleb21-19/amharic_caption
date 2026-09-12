@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Amharic Captions - Installer

rem ============================================================
rem  Amharic Captions - Premiere Pro
rem  One-click installer for Windows.
rem
rem  Does everything automatically:
rem    - copies com.amharic.captions into Adobe's CEP folder
rem    - enables the CSXS PlayerDebugMode registry keys
rem    - verifies the install
rem    - writes a log to %TEMP%\amharic-captions-install.log
rem
rem  Double-click this file. If Windows asks, click "Yes"
rem  (administrator permission is required to write to
rem   Program Files).
rem ============================================================

set "NAME=com.amharic.captions"
set "SRC=%~dp0%NAME%"
set "LOG=%TEMP%\amharic-captions-install.log"

rem ---- reset + open the log ----
> "%LOG%" echo === Amharic Captions installer log ===
>> "%LOG%" echo [%date% %time%] start: %~f0

rem ---- check we are running next to the extension folder ----
if not exist "%SRC%\CSXS\manifest.xml" (
  >> "%LOG%" echo [%date% %time%] ERROR: manifest.xml not next to installer
  echo  [ERROR] Could not find the extension next to this installer.
  echo.
  echo  This file must stay inside the unzipped "amharic-captions-win-x64"
  echo  folder, side by side with the com.amharic.captions folder.
  echo.
  echo  Unzip the download fully, then run Install.cmd again.
  echo.
  echo  (A log was saved to %LOG%)
  echo.
  pause
  exit /b 1
)
>> "%LOG%" echo [%date% %time%] found extension folder at %SRC%

rem ---- restore the Mark-of-the-Web so SmartScreen stays quiet ----
powershell -NoProfile -ExecutionPolicy Bypass -Command "Unblock-File -Path '%~f0'; Unblock-File -Path '%SRC%\CSXS\manifest.xml'" >nul 2>&1
>> "%LOG%" echo [%date% %time%] cleared Mark-of-the-Web

rem ---- elevation: re-run ourselves as administrator if needed ----
net session >nul 2>&1
set "IS_ADMIN=%errorlevel%"
if %IS_ADMIN% neq 0 (
  >> "%LOG%" echo [%date% %time%] not elevated; requesting admin
  echo  Administrator permission is needed to install into Program Files.
  echo  If Windows asks, click "Yes".
  echo  The installer will reopen and install automatically.
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -Verb RunAs -FilePath '%~f0' -WorkingDirectory '%~dp0'"
  echo  Installer started. Check the new window for the result.
  echo  (Log: %LOG%)
  echo.
  pause
  exit /b 0
)
>> "%LOG%" echo [%date% %time%] running as administrator

rem ---- choose the CEP extensions folder ----
set "BASE=%ProgramFiles(x86)%\Common Files\Adobe\CEP\extensions"
if "%ProgramFiles(x86)%"=="" set "BASE=%ProgramFiles%\Common Files\Adobe\CEP\extensions"
set "DEST=%BASE%\%NAME%"

echo  Target folder:
echo    %DEST%
echo.
>> "%LOG%" echo [%date% %time%] target folder: %DEST%

rem ---- make sure the CEP extensions folder exists ----
if not exist "%BASE%" (
  >> "%LOG%" echo [%date% %time%] creating base: %BASE%
  echo  Creating "%BASE%" ...
  mkdir "%BASE%"
  if errorlevel 1 (
    >> "%LOG%" echo [%date% %time%] ERROR: could not create base
    echo  [ERROR] Could not create the CEP extensions folder.
    echo  Try running Install.cmd again.
    echo  (Log: %LOG%)
    pause
    exit /b 1
  )
)
>> "%LOG%" echo [%date% %time%] CEP base ready

rem ---- remove any previous install so files do not mix ----
if exist "%DEST%" (
  >> "%LOG%" echo [%date% %time%] previous install found, removing
  echo  Removing previous version ...
  rmdir /s /q "%DEST%" 2>nul
  if exist "%DEST%" (
    >> "%LOG%" echo [%date% %time%] ERROR: previous copy locked
    echo  [ERROR] A previous copy is in use (locked).
    echo.
    echo  Did you leave Premiere Pro open? Close it completely, then run
    echo  Install.cmd again.
    echo  (Log: %LOG%)
    echo.
    pause
    exit /b 1
  )
)
>> "%LOG%" echo [%date% %time%] previous install cleared

rem ---- copy the extension (robocopy is 1=ok, >=8 = real failure) ----
echo  Copying files - this can take a minute ...
>> "%LOG%" echo [%date% %time%] robocopy start
robocopy "%SRC%" "%DEST%" /E /PURGE /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS
set "RC=%errorlevel%"
>> "%LOG%" echo [%date% %time%] robocopy exit code: %RC% (0-7 = ok)
if %RC% GTR 7 (
  echo  [ERROR] Copy failed with code %RC%.
  echo.
  echo  Try running Install.cmd again, or close other programs that may
  echo  be locking the files.
  echo  (Log: %LOG%)
  echo.
  pause
  exit /b 1
)

rem ---- enable the extension debug keys (covers all recent Premiere) ----
echo  Enabling Adobe extension support ...
for %%K in (7 8 9 10 11 12 13 14 15) do (
  reg add "HKCU\Software\Adobe\CSXS.%%K" /v PlayerDebugMode /t REG_SZ /d 1 /f >> "%LOG%" 2>&1
)
>> "%LOG%" echo [%date% %time%] PlayerDebugMode keys set (CSXS.7-15)

rem ---- verify the install ----
if not exist "%DEST%\CSXS\manifest.xml"          goto :bad
if not exist "%DEST%\index.html"                 goto :bad
if not exist "%DEST%\runtime\model\model.bin"    goto :model
if not exist "%DEST%\runtime\python\python.exe"  goto :model
>> "%LOG%" echo [%date% %time%] verification passed

echo.
echo  =============================================
echo   DONE - installation successful!
echo  =============================================
echo.
echo  Next steps:
echo    1. Fully quit Premiere Pro  (File - Exit)
echo    2. Reopen Premiere Pro
echo    3. Menu:  Window  Extension  Amharic Captions
echo.
echo  If you previously had an older version installed, it has been
echo  replaced by this one.
echo.
echo  (Log: %LOG%)
echo.
pause
exit /b 0

:model
>> "%LOG%" echo [%date% %time%] WARNING: model files missing
echo  [WARNING] The panel was copied, but the AI engine files were not
echo  found. The installer may have been separated from the full package.
echo  Re-unzip the complete amharic-captions-win-x64.zip and retry.
echo  (Log: %LOG%)
echo.
pause
exit /b 1

:bad
>> "%LOG%" echo [%date% %time%] ERROR: verification failed (manifest/index missing)
echo  [ERROR] The install is incomplete or corrupted.
echo  Re-unzip the complete amharic-captions-win-x64.zip and run
echo  Install.cmd again.
echo  (Log: %LOG%)
echo.
pause
exit /b 1