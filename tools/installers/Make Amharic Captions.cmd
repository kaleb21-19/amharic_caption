@echo off
rem Amharic Captions Pro for CapCut, DaVinci Resolve and other editors
rem (no Premiere / After Effects needed). Opens the app window; a video
rem dropped on this file or on its desktop shortcut opens ready to caption.
rem AMH_CONSOLE=1 runs the classic console SRT maker instead - the app falls
rem back to it by itself when it cannot open a window.
rem No ( ) blocks below on purpose: a dropped file name with brackets in it,
rem e.g. video(2).mp4, would end such a block early.
setlocal
chcp 65001 >nul
set "RT=%~dp0runtime"
if not exist "%RT%\python\python.exe" goto missing
if /i "%AMH_CONSOLE%"=="1" goto console
if not exist "%~dp0app\amh_app.py" goto console
if not exist "%RT%\python\pythonw.exe" goto console
start "" "%RT%\python\pythonw.exe" -E -s -X utf8 "%~dp0app\amh_app.py" %*
exit /b 0

:console
title Amharic Captions Pro - SRT maker
"%RT%\python\python.exe" -E -s -X utf8 "%RT%\amh_standalone.py" %*
echo.
echo Press any key to close this window.
pause >nul
exit /b 0

:missing
echo The Amharic Captions files were not found. Run Install.cmd again.
pause
exit /b 1
