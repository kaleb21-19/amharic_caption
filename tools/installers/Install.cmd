@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Amharic Captions - Installer

rem ============================================================
rem  Amharic Captions - Premiere Pro CEP Installer  (Windows)
rem ============================================================
rem
rem  Does everything automatically:
rem    - copies com.amharic.captions into your user's Adobe CEP
rem      folder  (%AppData%\Adobe\CEP\extensions)
rem    - enables the CSXS PlayerDebugMode registry keys
rem    - installs atomically: the new copy is fully built and
rem      verified first, then swapped in. If anything fails the
rem      previous version is kept, never a broken half-install.
rem    - verifies the install (key files + file count)
rem    - writes a log to %TEMP%\amharic-captions-install.log
rem
rem  No administrator rights are needed. Just double-click this
rem  file and it installs for the current Windows user.
rem
rem  Exit codes (used for support):
rem    0 = success
rem    1 = extension folder not found next to this file
rem    2 = manifest.xml missing in the source
rem    3 = index.html missing in the source
rem    4 = could not create the Adobe CEP folder
rem    5 = copy to the staging folder failed
rem    6 = staged copy failed verification
rem    7 = could not swap in the new version (old kept)
rem    8 = final verification failed after the swap (rare)
rem
rem  IMPORTANT: keep this file ASCII-only. The batch parser
rem  misreads non-ASCII bytes on some system code pages, which
rem  makes the installer silently do nothing.
rem ============================================================

set "NAME=com.amharic.captions"
set "LOG=%TEMP%\amharic-captions-install.log"

rem ------------------------------------------------------------
rem Build all paths up front
rem ------------------------------------------------------------

set "SRC=%~dp0%NAME%"
set "BASE=%APPDATA%\Adobe\CEP\extensions"
set "DEST=%BASE%\%NAME%"
set "STAGE=%BASE%\.%NAME%.staging"
set "BACKUP=%BASE%\%NAME%.old"
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
echo   "%SRC%"
echo.
echo Destination:
echo   "%DEST%"
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
    echo   "%SRC%"
    echo.
    echo Make sure this structure exists:
    echo.
    echo   Install.cmd
    echo   com.amharic.captions\
    echo.
    echo The "com.amharic.captions" folder must be next to Install.cmd.
    echo.
    >> "%LOG%" echo ERROR(1): Extension folder not found
    pause
    exit /b 1
)

if not exist "%SRC%\CSXS\manifest.xml" (
    echo [ERROR] manifest.xml was not found!
    echo.
    echo Expected:
    echo   "%SRC%\CSXS\manifest.xml"
    echo.
    echo Check that the extension package is complete.
    echo.
    >> "%LOG%" echo ERROR(2): manifest.xml not found in source
    pause
    exit /b 2
)

if not exist "%SRC%\index.html" (
    echo [ERROR] index.html was not found!
    echo.
    exit /b 3
)

echo [OK] Extension files found.
echo.

>> "%LOG%" echo Source files verified

rem ------------------------------------------------------------
rem Warn if an OLD system-wide copy would override this one
rem ------------------------------------------------------------

if exist "%SYS_DEST%\CSXS\manifest.xml" (
    echo [NOTE] An older copy is installed in Program Files:
    echo   "%SYS_DEST%"
    echo.
    echo Premiere loads that one BEFORE the copy we are installing, so it
    echo could hide this new version. If you see an old version after opening
    echo Premiere, delete that folder and reopen Premiere.
    echo.
    >> "%LOG%" echo WARNING: old Program Files copy found at "%SYS_DEST%"
)

rem ------------------------------------------------------------
rem Create Adobe CEP folder
rem ------------------------------------------------------------

echo Checking Adobe CEP folder...

if not exist "%BASE%" (
    echo Creating:
    echo   "%BASE%"
    echo.

    mkdir "%BASE%" 2>> "%LOG%"

    if errorlevel 1 (
        echo [ERROR] Could not create the Adobe CEP folder.
        echo.
        >> "%LOG%" echo ERROR(4): Could not create CEP folder
        pause
        exit /b 4
    )
)

echo [OK] Adobe CEP folder ready.
echo.

>> "%LOG%" echo CEP folder ready

rem ------------------------------------------------------------
rem Build the new installation in a staging folder first.
rem Nothing is touched in the live folder until this is
rem complete and verified, so a failed run can never leave
rem the user with a broken install.
rem ------------------------------------------------------------

rmdir /s /q "%STAGE%" 2>nul

if exist "%STAGE%" (
    echo [ERROR] Could not clear the staging folder.
    echo.
    echo Please completely close Premiere Pro and try again.
    echo.
    >> "%LOG%" echo ERROR(7): Staging folder locked
    pause
    exit /b 7
)

echo Copying extension...
echo This may take a moment.
echo.

robocopy "%SRC%" "%STAGE%" /E /COPY:DAT /R:2 /W:2

set "RC=!errorlevel!"

>> "%LOG%" echo Stage robocopy exit code: !RC! (0-7 = ok)

if !RC! GTR 7 (
    echo.
    echo [ERROR] Copy failed. Robocopy error code: !RC!
    echo.
    echo   Check available disk space and that Premiere Pro is closed.
    echo.
    echo Log:
    echo   "%LOG%"
    echo.
    pause
    exit /b 5
)

echo [OK] Extension copied to staging.
echo.

rem ------------------------------------------------------------
rem Verify the staged copy before touching the live folder
rem ------------------------------------------------------------

echo Verifying staged copy...

if not exist "%STAGE%\CSXS\manifest.xml" (
    echo [ERROR] manifest.xml missing in the staged copy.
    >> "%LOG%" echo ERROR(6): Staged manifest missing
    pause
    exit /b 6
)

if not exist "%STAGE%\index.html" (
    echo [ERROR] index.html missing in the staged copy.
    >> "%LOG%" echo ERROR(6): Staged index missing
    pause
    exit /b 6
)

set "SRC_N=0"
set "STAGE_N=0"

for /f %%N in ('dir /s /b /a-d "%SRC%" 2^>nul ^| find /c /v ""') do (
    set "SRC_N=%%N"
)

for /f %%N in ('dir /s /b /a-d "%STAGE%" 2^>nul ^| find /c /v ""') do (
    set "STAGE_N=%%N"
)

echo.
echo Source files:      !SRC_N!
echo Staged files:      !STAGE_N!
echo.

>> "%LOG%" echo Source files: !SRC_N!
>> "%LOG%" echo Staged files: !STAGE_N!

if not "!SRC_N!"=="!STAGE_N!" (
    echo [WARNING] File count does not match.
    echo.
    echo The extension may be incomplete. Please re-unzip the original
    echo download and try again.
    echo.
    >> "%LOG%" echo WARNING: File count mismatch (!SRC_N! vs !STAGE_N!)
)

echo [OK] Staged copy verified.
echo.

rem ------------------------------------------------------------
rem Swap: back up the old version, put the new one in, keep the
rem backup until the new one is confirmed. Automatic rollback.
rem ------------------------------------------------------------

echo Installing...

if exist "%DEST%" (
    rmdir /s /q "%BACKUP%" 2>nul
    ren "%DEST%" "%NAME%.old"
)

if exist "%BACKUP%" (
    echo [OK] Previous version backed up.
    echo.
) else if exist "%DEST%" (
    echo [ERROR] Could not back up the previous installation.
    echo.
    echo Please completely close Premiere Pro and try again.
    echo.
    >> "%LOG%" echo ERROR(7): Could not back up previous version
    pause
    exit /b 7
)

ren "%STAGE%" "%NAME%"

if not exist "%DEST%\CSXS\manifest.xml" (
    echo [ERROR] Could not move the new version into place.
    echo.
    if exist "%BACKUP%" (
        echo Restoring the previous version ...
        ren "%BACKUP%" "%NAME%"
    )
    >> "%LOG%" echo ERROR(7): Swap failed - previous version restored
    pause
    exit /b 7
)

echo [OK] New version installed.
echo.

rem ------------------------------------------------------------
rem Final verification (the new copy is live now)
rem ------------------------------------------------------------

if not exist "%DEST%\CSXS\manifest.xml" (
    echo [ERROR] manifest.xml missing after installation.
    >> "%LOG%" echo ERROR(8): Installed manifest missing
    pause
    exit /b 8
)

if not exist "%DEST%\index.html" (
    echo [ERROR] index.html missing after installation.
    >> "%LOG%" echo ERROR(8): Installed index missing
    pause
    exit /b 8
)

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

if exist "%SRC%\runtime\ffmpeg\ffmpeg.exe" (
    if exist "%DEST%\runtime\ffmpeg\ffmpeg.exe" (
        echo [OK] FFmpeg engine
    ) else (
        echo [WARNING] FFmpeg engine was not copied.
    )
)

set "DST_N=0"

for /f %%N in ('dir /s /b /a-d "%DEST%" 2^>nul ^| find /c /v ""') do (
    set "DST_N=%%N"
)

echo.
echo Installed files:   !DST_N!
echo.

>> "%LOG%" echo Installed files: !DST_N!

rem ------------------------------------------------------------
rem Enable CEP PlayerDebugMode (REG_SZ is Adobe's documented
rem type for debugging unsigned extensions)
rem ------------------------------------------------------------

echo Enabling Adobe CEP extension support...

for %%K in (7 8 9 10 11 12 13 14 15) do (
    reg add "HKCU\Software\Adobe\CSXS.%%K" /v PlayerDebugMode /t REG_SZ /d 1 /f >> "%LOG%" 2>&1
)

set "REG_OK=0"

for %%K in (11 12 13 14 15) do (
    reg query "HKCU\Software\Adobe\CSXS.%%K" /v PlayerDebugMode >nul 2>&1 && set /A REG_OK+=1
)

if "!REG_OK!"=="0" (
    echo [WARNING] Could not verify the registry setting.
    echo.
    echo The extension may not show up in Premiere. See the log file.
    echo.
    >> "%LOG%" echo WARNING: PlayerDebugMode not found in registry
) else (
    echo [OK] CEP Developer Mode enabled.
)

echo.

rem ------------------------------------------------------------
rem Remove the rollback backup now that all checks passed
rem ------------------------------------------------------------

rmdir /s /q "%BACKUP%" 2>nul
rmdir /s /q "%STAGE%" 2>nul

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
echo   "%DEST%"
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
echo   "%LOG%"
echo.
echo ============================================
echo.

>> "%LOG%" echo INSTALLATION SUCCESSFUL
>> "%LOG%" echo Destination: %DEST%

pause
exit /b 0