@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem ============================================================
rem  Window-keeping bootstrap:
rem  If run interactively (double-click), relaunch under
rem  "cmd /k" so the window stays open at the end instead of
rem  flashing and vanishing. Silent mode still runs and exits
rem  and passes the real exit code back to the caller.
rem ============================================================

if /I "%~1"=="/keepopen" goto :main
if /I "%~1"=="/silent" (
    cmd /c call "%~f0" /keepopen /silent
    exit /b !errorlevel!
)
cmd /k call "%~f0" /keepopen
exit /b 0

rem The "cmd /k" or "cmd /c" instance lands here with the original
rem user argument (for example /silent) passed along as argument 2.

:main

title Amharic Captions - Installer
color 07

rem ============================================================
rem  Amharic Captions - Premiere Pro CEP Installer (Windows)
rem ============================================================
rem
rem  Usage:
rem    Install.cmd            interactive (default)
rem    Install.cmd /silent    no pauses, no popups (IT provisioning)
rem
rem  This installer:
rem    - copies com.amharic.captions into your Adobe CEP folder
rem        %APPDATA%\Adobe\CEP\extensions
rem    - enables the CSXS PlayerDebugMode registry keys
rem    - installs atomically: a fresh copy is built in a staging
rem      folder and verified first, then swapped into place. A
rem      failed run can never leave a broken half-install.
rem    - keeps the previous version as a one-step rollback copy in
rem      %APPDATA%\Adobe\CEP (next to the extensions folder, not
rem      inside it, so Premiere never scans the backup as a second
rem      copy of the panel). Staging and rollback names are unique
rem      per run, so a locked leftover folder never causes a failure.
rem    - verifies key files and the file count, and always writes
rem      a log to  %TEMP%\amharic-captions-install.log
rem
rem  No administrator rights are needed. Double-click and follow the
rem  friendly prompts. On any problem you get a loud red screen, a
rem  popup dialog and the log path, so a failure is never silent.
rem
rem  Exit codes (also recorded in the log):
rem   0 success
rem   1 extension folder missing next to this file
rem   2 manifest.xml missing in the source
rem   3 index.html missing in the source
rem   4 could not create the Adobe CEP folder
rem   5 copy to the staging folder failed
rem   6 staged copy failed verification
rem   7 could not swap versions (previous version preserved)
rem   8 final verification failed after the swap (rare)
rem
rem  IMPORTANT: keep this file ASCII-only with no exclamation marks
rem  in any echoed text (delayed expansion is on). Non-ASCII bytes
rem  can be misread on some code pages, which makes the installer
rem  silently do nothing. Save it with Windows (CRLF) line endings.
rem
rem  IMPORTANT: inside any parenthesized block, never echo an
rem  unquoted percent variable that holds a path. Use the delayed
rem  form or quote it, because a path can contain a closing
rem  parenthesis and that ends the block early.
rem ============================================================

echo Starting Amharic Captions installer...

set "NAME=com.amharic.captions"
set "LOG=%TEMP%\amharic-captions-install.log"

> "%LOG%" echo ================================================
>> "%LOG%" echo Amharic Captions Installer
>> "%LOG%" echo ================================================
>> "%LOG%" echo Start: %date% %time%
>> "%LOG%" echo User:  %USERNAME%
>> "%LOG%" echo CMD:   "%~f0"

rem If the window flashed closed and no log file exists, Windows or
rem an antivirus blocked this script before it could run. Fix that
rem by right-clicking the downloaded zip, Properties, Unblock, then
rem Extract All, and running Install.cmd from the extracted folder.

rem ------------------------------------------------------------
rem Options
rem ------------------------------------------------------------

set "SILENT=0"
if /I "%~1"=="/silent" set "SILENT=1"
if /I "%~2"=="/silent" set "SILENT=1"

set "PAUSE=pause"
if "!SILENT!"=="1" set "PAUSE=rem"

rem ------------------------------------------------------------
rem Paths (a unique run id means locked leftovers never block us)
rem ------------------------------------------------------------

set "RUN=%RANDOM%"
set "SRC=%~dp0%NAME%"
set "ROOT=%APPDATA%\Adobe\CEP"
set "BASE=%ROOT%\extensions"
set "DEST=%BASE%\%NAME%"
set "STAGE=%ROOT%\%NAME%.staging%RUN%"
set "BACKUP=%ROOT%\%NAME%.old%RUN%"
set "PF86=%ProgramFiles(x86)%"
set "SYS_DEST=%PF86%\Common Files\Adobe\CEP\extensions\%NAME%"

>> "%LOG%" echo Silent: !SILENT!
>> "%LOG%" echo Source: "%SRC%"
>> "%LOG%" echo Destination: "%DEST%"

rem ------------------------------------------------------------
rem Welcome
rem ------------------------------------------------------------

if "!SILENT!"=="0" (
    echo.
    echo ================================================
    echo     AMHARIC CAPTIONS - INSTALLER
    echo ================================================
    echo.
    echo Welcome. This installs Amharic Captions into
    echo Premiere Pro for your Windows user. It takes a
    echo moment and needs no administrator rights.
    echo.
    echo Two hints first:
    echo   - Fully quit Premiere Pro before installing.
    echo   - Make sure this folder was extracted from the
    echo     zip you downloaded, right-click and Extract All.
    echo.
    echo Press any key to begin when you are ready.
    echo.
    %PAUSE%
)

rem ------------------------------------------------------------
rem Check the source folder (the extension next to this file)
rem ------------------------------------------------------------

echo.
echo Checking extension files...
echo.

if not exist "%SRC%" (
    >> "%LOG%" echo ERROR 1: extension folder missing at "%SRC%"
    call :FAIL 1 "The extension folder was not found next to the installer. Extract the zip you downloaded, then run Install.cmd from the extracted folder."
    exit /b 1
)

if not exist "%SRC%\CSXS\manifest.xml" (
    >> "%LOG%" echo ERROR 2: manifest.xml missing at "%SRC%\CSXS\manifest.xml"
    call :FAIL 2 "The download looks damaged, manifest.xml is missing. Re-download the zip and extract it again before running Install.cmd."
    exit /b 2
)

if not exist "%SRC%\index.html" (
    >> "%LOG%" echo ERROR 3: index.html missing at "%SRC%\index.html"
    call :FAIL 3 "The download looks damaged, index.html is missing. Re-download the zip and extract it again before running Install.cmd."
    exit /b 3
)

echo [OK] Extension files found.
>> "%LOG%" echo Source files verified

rem ------------------------------------------------------------
rem Read the version from the manifest for display. The attribute
rem can sit anywhere on a line with other attributes, so drop the
rem quotes, cut everything up to the attribute name, then take the
rem first token after it.
rem ------------------------------------------------------------

set "VER=unknown"
for /f "delims=" %%L in ('findstr /i /c:"ExtensionBundleVersion=" "%SRC%\CSXS\manifest.xml" 2^>nul') do (
    set "VLINE=%%L"
    set "VLINE=!VLINE:"=!"
    set "VLINE=!VLINE:*ExtensionBundleVersion=!"
    for /f "tokens=1 delims== >/" %%A in ("!VLINE!") do set "VER=%%A"
)
if "!VER!"=="" set "VER=unknown"
>> "%LOG%" echo Version: !VER!

rem ------------------------------------------------------------
rem Warn if an old system-wide copy would override this one
rem ------------------------------------------------------------

if exist "%SYS_DEST%\CSXS\manifest.xml" (
    color 0E
    echo [NOTE] An older copy is installed in Program Files:
    echo    "%SYS_DEST%"
    echo.
    echo Premiere loads that one before your copy, so it could hide
    echo the new version. If you see an old version after opening
    echo Premiere, delete that folder and reopen Premiere.
    echo.
    >> "%LOG%" echo WARNING: old Program Files copy at "%SYS_DEST%"
)

rem ------------------------------------------------------------
rem Check whether Premiere is running (explains file locks).
rem Filter on the exact process name, and match the whole name
rem with /c so a space does not turn into an OR search.
rem ------------------------------------------------------------

set "PP_RUNNING=0"
tasklist /FI "IMAGENAME eq Adobe Premiere Pro.exe" /FO CSV /NH 2>nul | findstr /i /c:"Adobe Premiere Pro.exe" >nul && set "PP_RUNNING=1"

if "!PP_RUNNING!"=="1" (
    color 0E
    echo [NOTE] Adobe Premiere Pro is currently running.
    echo.
    echo For the cleanest result, fully quit Premiere now and then
    echo run the installer again. Continuing now can fail when the
    echo previous version is replaced.
    echo.
    %PAUSE%
)

>> "%LOG%" echo Premiere Pro running: !PP_RUNNING!

rem ------------------------------------------------------------
rem Create the Adobe CEP folder
rem ------------------------------------------------------------

echo.
echo Checking the Adobe CEP folder...

if not exist "%BASE%" (
    echo Creating:
    echo    "%BASE%"
    echo.
    mkdir "%BASE%" 2>> "%LOG%"
    if errorlevel 1 (
        >> "%LOG%" echo ERROR 4: could not create "%BASE%"
        call :FAIL 4 "Windows could not create the Adobe CEP folder. Sign in to Windows normally and run the installer again."
        exit /b 4
    )
)

echo [OK] Adobe CEP folder ready.
>> "%LOG%" echo CEP folder ready

rem ------------------------------------------------------------
rem Build the new version in staging first. Nothing is touched in
rem the live folder until this copy is complete and verified.
rem ------------------------------------------------------------

echo.
echo Copying the extension to a staging folder...
echo This may take a moment.
echo.

robocopy "%SRC%" "%STAGE%" /E /COPY:DAT /R:2 /W:2 /XJ

set "RC=!errorlevel!"

>> "%LOG%" echo Stage robocopy exit code: !RC!   (0-7 = ok)

if !RC! GTR 7 (
    rmdir /s /q "%STAGE%" 2>nul
    >> "%LOG%" echo ERROR 5: robocopy failed with code !RC!
    call :FAIL 5 "The extension could not be copied to its staging folder, robocopy code !RC!. Close Premiere Pro, make sure disk space is free, then run the installer again."
    exit /b 5
)

echo [OK] Extension copied to staging.

rem ------------------------------------------------------------
rem Verify the staged copy before touching the live folder
rem ------------------------------------------------------------

echo Verifying the staged copy...

if not exist "%STAGE%\CSXS\manifest.xml" (
    rmdir /s /q "%STAGE%" 2>nul
    >> "%LOG%" echo ERROR 6: staged manifest missing
    call :FAIL 6 "The staged copy is missing manifest.xml. The download is probably incomplete. Re-download and extract the zip again."
    exit /b 6
)

if not exist "%STAGE%\index.html" (
    rmdir /s /q "%STAGE%" 2>nul
    >> "%LOG%" echo ERROR 6: staged index missing
    call :FAIL 6 "The staged copy is missing index.html. The download is probably incomplete. Re-download and extract the zip again."
    exit /b 6
)

set "SRC_N=0"
set "STAGE_N=0"

for /f %%N in ('dir /s /b /a-d "%SRC%" 2^>nul ^| find /c /v ""') do set "SRC_N=%%N"
for /f %%N in ('dir /s /b /a-d "%STAGE%" 2^>nul ^| find /c /v ""') do set "STAGE_N=%%N"

echo.
echo Source files: !SRC_N!
echo Staged files: !STAGE_N!
echo.

>> "%LOG%" echo Source files: !SRC_N!
>> "%LOG%" echo Staged files: !STAGE_N!

if not "!SRC_N!"=="!STAGE_N!" (
    color 0E
    echo [WARNING] File count does not match, the numbers are shown above.
    echo The extension may be incomplete. Re-unzip the download and try again.
    >> "%LOG%" echo WARNING: file count mismatch !SRC_N! vs !STAGE_N!
)

echo [OK] Staged copy verified.
echo.

rem ------------------------------------------------------------
rem Swap: move the old version aside, move the new one in, verify
rem each step, and restore the previous version if anything fails.
rem ------------------------------------------------------------

echo Installing...
set "HAD_OLD=0"
set "RESTORED=0"

if exist "%DEST%" (
    set "HAD_OLD=1"
    move /Y "%DEST%" "%BACKUP%" >nul 2>&1

    if errorlevel 1 (
        rmdir /s /q "%STAGE%" 2>nul
        >> "%LOG%" echo ERROR 7: could not move old version aside
        if "!PP_RUNNING!"=="1" call :FAIL 7 "Premiere Pro still has the extension open, so the old copy could not be moved aside. Fully quit Premiere using File Exit, then run the installer again."
        if not "!PP_RUNNING!"=="1" call :FAIL 7 "The previous copy could not be moved aside because a file is in use. Close Premiere Pro and any folder windows, then run the installer again."
        exit /b 7
    )

    echo [OK] Previous version moved safely to the backup folder.
    >> "%LOG%" echo Backup created: "!BACKUP!"
)

move /Y "%STAGE%" "%DEST%" >nul 2>&1

if errorlevel 1 (
    >> "%LOG%" echo ERROR 7: could not move the new version into place
    set "RESTORED=0"
    if exist "%BACKUP%" (
        move /Y "%BACKUP%" "%DEST%" >nul 2>&1
        if not errorlevel 1 set "RESTORED=1"
    )
    rmdir /s /q "%STAGE%" 2>nul
    if "!RESTORED!"=="1" call :FAIL 7 "The new copy could not be moved into place, so the previous version was restored. Close Premiere Pro and any folder windows, then run the installer again."
    if not "!RESTORED!"=="1" call :FAIL 7 "The new copy could not be moved into place and the automatic restore did not finish. Your previous version is kept safely, the log file shows its path. Send that log to @AmharicCaptionsBot and we will sort it out."
    exit /b 7
)

if not exist "%DEST%\CSXS\manifest.xml" (
    >> "%LOG%" echo ERROR 8: new version missing at the destination
    set "RESTORED=0"
    rmdir /s /q "%DEST%" 2>nul
    if exist "%BACKUP%" (
        move /Y "%BACKUP%" "%DEST%" >nul 2>&1
        if not errorlevel 1 set "RESTORED=1"
    )
    rmdir /s /q "%STAGE%" 2>nul
    if "!RESTORED!"=="1" call :FAIL 8 "The new copy did not appear correctly at the destination, so the previous version was restored. Run the installer once more, it repairs itself cleanly."
    if not "!RESTORED!"=="1" call :FAIL 8 "The new copy did not appear correctly at the destination. The previous version is kept safely, the log file shows its path. Send that log to @AmharicCaptionsBot and we will put it right."
    exit /b 8
)

echo [OK] New version installed.
echo.

rem ------------------------------------------------------------
rem Final verification (the new copy is live now)
rem ------------------------------------------------------------

if not exist "%DEST%\index.html" (
    >> "%LOG%" echo ERROR 8: index.html missing after install
    call :FAIL 8 "The installed copy is incomplete, index.html is missing. Run the installer once more, it repairs itself. If it repeats, send the log to @AmharicCaptionsBot."
    exit /b 8
)

if exist "%SRC%\runtime\model\model.bin" (
    if exist "%DEST%\runtime\model\model.bin" (
        echo [OK] AI model
    ) else (
        color 0E
        echo [WARNING] AI model was not copied.
    )
)

if exist "%SRC%\runtime\python\python.exe" (
    if exist "%DEST%\runtime\python\python.exe" (
        echo [OK] Python engine
    ) else (
        color 0E
        echo [WARNING] Python engine was not copied.
    )
)

if exist "%SRC%\runtime\ffmpeg\ffmpeg.exe" (
    if exist "%DEST%\runtime\ffmpeg\ffmpeg.exe" (
        echo [OK] FFmpeg engine
    ) else (
        color 0E
        echo [WARNING] FFmpeg engine was not copied.
    )
)

set "DST_N=0"

for /f %%N in ('dir /s /b /a-d "%DEST%" 2^>nul ^| find /c /v ""') do set "DST_N=%%N"

echo.
echo Installed files: !DST_N!
echo.

>> "%LOG%" echo Installed files: !DST_N!

rem ------------------------------------------------------------
rem Enable CEP PlayerDebugMode (REG_SZ is Adobe's documented type
rem for debugging unsigned extensions)
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
    color 0E
    echo [WARNING] Could not verify the registry setting, so the panel
    echo may not appear in Premiere. See the log for details.
    >> "%LOG%" echo WARNING: PlayerDebugMode not confirmed
) else (
    echo [OK] CEP Developer Mode enabled.
)

echo.

rem ------------------------------------------------------------
rem Finish: keep only the newest rollback copy (when this run made
rem one) and clear stale staging folders. The last two lines also
rem remove leftovers that older installer versions put inside the
rem extensions folder, where Premiere would scan them.
rem ------------------------------------------------------------

if "!HAD_OLD!"=="1" (
    for /d %%D in ("%ROOT%\%NAME%.old*") do (
        if /I not "%%D"=="%BACKUP%" rmdir /s /q "%%D" 2>nul
    )
)

for /d %%D in ("%ROOT%\%NAME%.staging*") do rmdir /s /q "%%D" 2>nul
for /d %%D in ("%BASE%\%NAME%.old*") do rmdir /s /q "%%D" 2>nul
for /d %%D in ("%BASE%\.%NAME%.staging*") do rmdir /s /q "%%D" 2>nul

>> "%LOG%" echo INSTALLATION SUCCESSFUL
>> "%LOG%" echo Version: !VER!
>> "%LOG%" echo Destination: "%DEST%"
if "!HAD_OLD!"=="1" >> "%LOG%" echo Backup kept: "%BACKUP%"
if "!HAD_OLD!"=="0" >> "%LOG%" echo Prepared as a fresh install

call :OK
%PAUSE%
exit /b 0

rem ============================================================
rem Success screen
rem ============================================================

:OK
color 0A
title Amharic Captions - Installed OK
echo.
echo ================================================================
echo     INSTALLATION SUCCESSFUL  v!VER!
echo ================================================================
echo.
echo   Amharic Captions is now installed for Premiere Pro.
echo.
echo   Take these 4 steps:
echo.
echo     1. Fully quit Premiere Pro:  File, Exit
echo        Closing the window is not enough, the panel list
echo        is only read when Premiere starts.
echo     2. Reopen Premiere Pro and open a project.
echo        The Extensions menu is greyed out on the start screen.
echo     3. Open  Window,  then  Extensions.
echo     4. Choose  Amharic Captions.
echo.
echo   Installed to:
echo     %DEST%
if "!HAD_OLD!"=="1" (
    echo.
    echo   A backup of your previous version is kept at:
    echo     !BACKUP!
)
if "!SILENT!"=="0" (
    echo.
    echo   Log file:
    echo     !LOG!
)
echo.
echo   You can close this window now, or press any key once more.
echo.
exit /b 0

rem ============================================================
rem Failure screen: red full-screen, popup dialog, log path,
rem plain next steps and a path to human support.
rem ============================================================

:FAIL
set "EC=%~1"
set "EMSG=%~2"
>> "%LOG%" echo FAILED(%EC%): %EMSG%
title ERROR %EC% - Amharic Captions Installer
color 4F

if "!SILENT!"=="0" (
    msg * /TIME:0 "Amharic Captions: the install did not finish. %EMSG% The log is at %LOG%." 2>nul
)

echo.
echo ================================================================
echo     INSTALLATION DID NOT FINISH   (code %EC%)
echo ================================================================
echo.
echo   %EMSG%
echo.
echo   Details are in the log file:
echo     %LOG%
echo.
echo   If you need help, send that log to @AmharicCaptionsBot.
echo   Your previous version is never touched until the new copy is
echo   verified, so nothing is broken. Just follow the step above.
echo.
echo   This window stays open - press any key when you are ready.
echo.
%PAUSE%
exit /b 0
