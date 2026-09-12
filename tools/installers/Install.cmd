@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Amharic Captions - Installer

rem ============================================================
rem  Amharic Captions - Premiere Pro
rem  One-click installer for Windows.
rem
rem  Does everything automatically:
rem    - copies com.amharic.captions into your user's Adobe CEP
rem      folder  (%AppData%\Adobe\CEP\extensions)
rem    - enables the CSXS PlayerDebugMode registry keys
rem    - verifies the install (file count + key files)
rem    - writes a log to %TEMP%\amharic-captions-install.log
rem
rem  No administrator rights are needed. Just double-click this
rem  file and it installs for the current Windows user.
rem ============================================================

set "NAME=com.amharic.captions"
set "SRC=%~dp0%NAME%"
set "LOG=%TEMP%\amharic-captions-install.log"
set "DEST=%APPDATA%\Adobe\CEP\extensions\%NAME%"
set "BASE=%APPDATA%\Adobe\CEP\extensions"
set "PF86=%ProgramFiles(x86)%"
set "SYS_DEST=%PF86%\Common Files\Adobe\CEP\extensions\%NAME%"

rem ---- reset + open the log ----
> "%LOG%" echo === Amharic Captions installer log ===
>> "%LOG%" echo [%date% %time%] start: %~f0
>> "%LOG%" echo [%date% %time%] user: %USERNAME%

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

rem ---- warn if an OLD system-wide copy would override this one ----
if exist "%SYS_DEST%\CSXS\manifest.xml" (
  >> "%LOG%" echo [%date% %time%] WARNING: old Program Files copy found at %SYS_DEST%
  echo  [NOTE] An older copy is installed in Program Files
  echo  (%SYS_DEST%).
  echo.
  echo  Adobe loads that one BEFORE the copy we are about to install, so it
  echo  could hide the new version. If you see an old version after opening
  echo  Premiere, delete that folder and reopen Premiere.
  echo.
)

rem ---- target folder (per-user: no admin needed, no UAC redirects) ----
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

rem ---- verify the install (key files) ----
if not exist "%DEST%\CSXS\manifest.xml"          goto :bad
if not exist "%DEST%\index.html"                 goto :bad
if not exist "%DEST%\runtime\model\model.bin"    goto :model
if not exist "%DEST%\runtime\python\python.exe"  goto :model

rem ---- verify the install (file count matches source) ----
set "SRC_N=0"
set "DST_N=0"
for /f %%N in ('dir /s /b /a-d "%SRC%" 2^>nul ^| find /c /v ""') do set "SRC_N=%%N"
for /f %%N in ('dir /s /b /a-d "%DEST%" 2^>nul ^| find /c /v ""') do set "DST_N=%%N"
>> "%LOG%" echo [%date% %time%] file count source=%SRC_N% dest=%DST_N%
if not "%SRC_N%"=="%DST_N%" (
  >> "%LOG%" echo [%date% %time%] ERROR: file count mismatch
  echo  [ERROR] The install is incomplete (source has %SRC_N% files, but
  echo  only %DST_N% were copied).
  echo.
  echo  Unzip the complete amharic-captions-win-x64.zip again and retry.
  echo  (Log: %LOG%)
  echo.
  pause
  exit /b 1
)
>> "%LOG%" echo [%date% %time%] verification passed (%DST_N% files)

echo.
echo  =============================================
echo   DONE - installation successful!
echo  =============================================
echo.
echo  Installed to:
echo    %DEST%
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