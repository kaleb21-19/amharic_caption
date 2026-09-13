@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Amharic Captions - Installer

rem ============================================================
rem  Amharic Captions - Premiere Pro CEP Installer
rem ============================================================
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
set "LOG=%TEMP%\amharic-captions-install.log"

rem ------------------------------------------------------------
rem Find the extension next to this CMD file
rem ------------------------------------------------------------

set "SRC=%~dp0%NAME%"
set "BASE=%APPDATA%\Adobe\CEP\extensions"
set "DEST=%BASE%\%NAME%"
set "PF86=%ProgramFiles(x86)%"
set "SYS_DEST=%PF86%\Common Files\Adobe\CEP\extensions\%NAME%"

rem ------------------------------------------------------------
rem Start log
rem ------------------------------------------------------------

> "%LOG%" echo ============================================
>> "%LOG%" echo Amharic Captions Installer
>> "%LOG%" echo ============================================
>> "%LOG%" echo Date: %date% %time%
>> "%LOG%" echo User: %USERNAME%
>> "%LOG%" echo CMD: %~f0
>> "%LOG%" echo Source: %SRC%
>> "%LOG%" echo Destination: %DEST%

echo.
echo ============================================
echo     AMHARIC CAPTIONS INSTALLER
echo ============================================
echo.
echo Source:
echo   %SRC%
echo.
echo Destination:
echo   %DEST%
echo.

rem ------------------------------------------------------------
rem Check source folder
rem ------------------------------------------------------------

echo Checking extension files...
echo.

if not exist "%SRC%" (
    echo [ERROR] Extension folder not found!
    echo.
    echo Expected:
    echo   %SRC%
    echo.
    echo Make sure this structure exists:
    echo.
    echo   Install.cmd
    echo   com.amharic.captions\
    echo.
    echo The "com.amharic.captions" folder must be next to Install.cmd.
    echo.
    >> "%LOG%" echo ERROR: Extension folder not found
    pause
    exit /b 1
)

if not exist "%SRC%\CSXS\manifest.xml" (
    echo [ERROR] manifest.xml was not found!
    echo.
    echo Expected:
    echo   %SRC%\CSXS\manifest.xml
    echo.
    echo Check that the extension package is complete.
    echo.
    >> "%LOG%" echo ERROR: manifest.xml not found
    pause
    exit /b 1
)

if not exist "%SRC%\index.html" (
    echo [ERROR] index.html was not found!
    echo.
    >> "%LOG%" echo ERROR: index.html not found
    pause
    exit /b 1
)

echo [OK] Extension files found.
echo.

>> "%LOG%" echo Source files verified

rem ------------------------------------------------------------
rem Warn if an OLD system-wide copy would override this one
rem ------------------------------------------------------------

if exist "%SYS_DEST%\CSXS\manifest.xml" (
    echo [NOTE] An older copy is installed in Program Files:
    echo   %SYS_DEST%
    echo.
    echo Premiere loads that one BEFORE the copy we are installing, so it
    echo could hide this new version. If you see an old version after opening
    echo Premiere, delete that folder and reopen Premiere.
    echo.
    >> "%LOG%" echo WARNING: old Program Files copy found at %SYS_DEST%
)

rem ------------------------------------------------------------
rem Create Adobe CEP folder
rem ------------------------------------------------------------

echo Checking Adobe CEP folder...

if not exist "%BASE%" (
    echo Creating:
    echo   %BASE%
    echo.

    mkdir "%BASE%" 2>> "%LOG%"

    if errorlevel 1 (
        echo [ERROR] Could not create Adobe CEP folder.
        echo.
        >> "%LOG%" echo ERROR: Could not create CEP folder
        pause
        exit /b 1
    )
)

echo [OK] Adobe CEP folder ready.
echo.

>> "%LOG%" echo CEP folder ready

rem ------------------------------------------------------------
rem Close old installation
rem ------------------------------------------------------------

if exist "%DEST%" (
    echo Removing previous installation...
    echo.

    rmdir /s /q "%DEST%" 2>> "%LOG%"

    if exist "%DEST%" (
        echo [ERROR] Could not remove the previous installation.
        echo.
        echo Please completely close Premiere Pro and try again.
        echo.
        >> "%LOG%" echo ERROR: Previous installation could not be removed
        pause
        exit /b 1
    )

    echo [OK] Previous installation removed.
    echo.
)

rem ------------------------------------------------------------
rem Copy extension
rem ------------------------------------------------------------

echo Copying extension...
echo This may take a moment.
echo.

robocopy "%SRC%" "%DEST%" /E /PURGE /COPY:DAT /R:2 /W:2

set "RC=!errorlevel!"

>> "%LOG%" echo Robocopy exit code: !RC! (0-7 = ok)

if !RC! GTR 7 (
    echo.
    echo [ERROR] Copy failed.
    echo Robocopy error code: !RC!
    echo.
    echo Log:
    echo   %LOG%
    echo.
    pause
    exit /b 1
)

echo.
echo [OK] Extension copied.
echo.

rem ------------------------------------------------------------
rem Enable CEP PlayerDebugMode
rem ------------------------------------------------------------

echo Enabling Adobe CEP extension support...
echo.

for %%K in (7 8 9 10 11 12 13 14 15) do (
    reg add "HKCU\Software\Adobe\CSXS.%%K" /v PlayerDebugMode /t REG_SZ /d 1 /f >> "%LOG%" 2>&1
)

echo [OK] CEP Developer Mode enabled.
echo.

rem ------------------------------------------------------------
rem Verify installation
rem ------------------------------------------------------------

echo Verifying installation...
echo.

if not exist "%DEST%\CSXS\manifest.xml" (
    echo [ERROR] manifest.xml missing after installation.
    >> "%LOG%" echo ERROR: Installed manifest missing
    pause
    exit /b 1
)

if not exist "%DEST%\index.html" (
    echo [ERROR] index.html missing after installation.
    >> "%LOG%" echo ERROR: Installed index.html missing
    pause
    exit /b 1
)

echo [OK] manifest.xml
echo [OK] index.html

if exist "%SRC%\runtime\model\model.bin" (
    if exist "%DEST%\runtime\model\model.bin" (
        echo [OK] AI model
    ) else (
        echo [WARNING] AI model was not copied.
    )
)

if exist "%SRC%\runtime\python\python.exe" (
    if exist "%DEST%\runtime\python\python.exe" (
        echo [OK] Python engine
    ) else (
        echo [WARNING] Python engine was not copied.
    )
)

rem ------------------------------------------------------------
rem Count files
rem ------------------------------------------------------------

set "SRC_N=0"
set "DST_N=0"

for /f %%N in ('dir /s /b /a-d "%SRC%" 2^>nul ^| find /c /v ""') do (
    set "SRC_N=%%N"
)

for /f %%N in ('dir /s /b /a-d "%DEST%" 2^>nul ^| find /c /v ""') do (
    set "DST_N=%%N"
)

echo.
echo Source files:      !SRC_N!
echo Installed files:   !DST_N!
echo.

>> "%LOG%" echo Source files: !SRC_N!
>> "%LOG%" echo Installed files: !DST_N!

if not "!SRC_N!"=="!DST_N!" (
    echo [WARNING] File count does not match.
    echo.
    echo The extension may be incomplete.
    echo.
    >> "%LOG%" echo WARNING: File count mismatch
)

rem ------------------------------------------------------------
rem Finished
rem ------------------------------------------------------------

echo.
echo ============================================
echo       INSTALLATION SUCCESSFUL
echo ============================================
echo.
echo Installed to:
echo.
echo   %DEST%
echo.
echo Next:
echo.
echo   1. Fully quit Premiere Pro  (File - Exit)
echo.
echo      Closing the window is NOT enough - the panel list is
echo      only read when Premiere starts up.
echo.
echo   2. Reopen Premiere Pro and OPEN a project.
echo.
echo      The Extensions menu is greyed out on the start screen.
echo.
echo   3. Go to:   Window ^> Extensions
echo.
echo   4. Select:  Amharic Captions
echo.
echo.
echo Log file:
echo   %LOG%
echo.
echo ============================================
echo.

>> "%LOG%" echo INSTALLATION SUCCESSFUL
>> "%LOG%" echo Destination: %DEST%

pause
exit /b 0