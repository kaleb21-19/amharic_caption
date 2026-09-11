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
rem
rem  Double-click this file. If Windows asks, click "Yes"
rem  (administrator permission is required to write to
rem   Program Files).
rem ============================================================

set "NAME=com.amharic.captions"
set "SRC=%~dp0%NAME%"
set "SRC_RESULT="

echo.
echo  =============================================
echo   Amharic Captions - Installer (Windows)
echo  =============================================
echo.

rem ---- check we are running next to the extension folder ----
if not exist "%SRC%\CSXS\manifest.xml" (
  echo  [ERROR] Could not find the extension next to this installer.
  echo.
  echo  This file must stay inside the unzipped "amharic-captions-win-x64"
  echo  folder, side by side with the com.amharic.captions folder.
  echo.
  echo  Unzip the download fully, then run Install.cmd again.
  echo.
  pause
  exit /b 1
)

rem ---- restore the Mark-of-the-Web so SmartScreen stays quiet ----
powershell -NoProfile -ExecutionPolicy Bypass -Command "Unblock-File -Path '%~f0'; Unblock-File -Path '%SRC%\CSXS\manifest.xml'" >nul 2>&1

rem ---- elevation: re-run ourselves as administrator if needed ----
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo  Administrator permission is needed to install into Program Files.
  echo  If Windows asks, click "Yes".
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -Verb RunAs -FilePath '%~f0' -WorkingDirectory '%~dp0'"
  exit /b %errorlevel%
)

rem ---- choose the CEP extensions folder ----
set "BASE=%ProgramFiles(x86)%\Common Files\Adobe\CEP\extensions"
if "%ProgramFiles(x86)%"=="" set "BASE=%ProgramFiles%\Common Files\Adobe\CEP\extensions"
set "DEST=%BASE%\%NAME%"

echo  Target folder:
echo    %DEST%
echo.

rem ---- make sure the CEP extensions folder exists ----
if not exist "%BASE%" (
  echo  Creating "%BASE%" ...
  mkdir "%BASE%"
  if errorlevel 1 (
    echo  [ERROR] Could not create the CEP extensions folder.
    echo  Try running Install.cmd again.
    pause
    exit /b 1
  )
)

rem ---- remove any previous install so files do not mix ----
if exist "%DEST%" (
  echo  Removing previous version ...
  rmdir /s /q "%DEST%" 2>nul
  if exist "%DEST%" (
    echo  [ERROR] A previous copy is in use (locked).
    echo.
    echo  Did you leave Premiere Pro open? Close it completely, then run
    echo  Install.cmd again.
    echo.
    pause
    exit /b 1
  )
)

rem ---- copy the extension (robocopy is 1=ok, >=8 = real failure) ----
echo  Copying files - this can take a minute ...
robocopy "%SRC%" "%DEST%" /E /PURGE /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS >nul
set "RC=%errorlevel%"
if %RC% GTR 7 (
  echo  [ERROR] Copy failed with code %RC%.
  echo.
  echo  Try running Install.cmd again, or close other programs that may
  echo  be locking the files.
  echo.
  pause
  exit /b 1
)

rem ---- enable the extension debug keys (covers all recent Premiere) ----
echo  Enabling Adobe extension support ...
for %%K in (7 8 9 10 11 12 13 14 15) do (
  reg add "HKCU\Software\Adobe\CSXS.%%K" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
)

rem ---- verify the install ----
if not exist "%DEST%\CSXS\manifest.xml" goto :bad
if not exist "%DEST%\index.html"          goto :bad
if not exist "%DEST%\runtime\model\model.bin" goto :model
if not exist "%DEST%\runtime\python\python.exe" goto :model

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
pause
exit /b 0

:model
echo  [WARNING] The panel was copied, but the AI engine files were not
echo  found. The installer may have been separated from the full package.
echo  Re-unzip the complete amharic-captions-win-x64.zip and retry.
echo.
pause
exit /b 1

:bad
echo  [ERROR] The install is incomplete or corrupted.
echo  Re-unzip the complete amharic-captions-win-x64.zip and run
echo  Install.cmd again.
echo.
pause
exit /b 1