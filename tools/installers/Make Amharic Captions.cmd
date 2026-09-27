@echo off
rem Amharic Captions Pro - standalone SRT maker (no Premiere / After Effects needed).
rem Drag video or audio files onto this file (or its desktop shortcut); an .srt
rem appears next to each one. Uses the runtime installed with the panel.
setlocal
chcp 65001 >nul
title Amharic Captions Pro - SRT maker
set "RT=%~dp0runtime"
if not exist "%RT%\python\python.exe" (
    echo The Amharic Captions files were not found. Run Install.cmd again.
    pause
    exit /b 1
)
"%RT%\python\python.exe" -E -s -X utf8 "%RT%\amh_standalone.py" %*
echo.
echo Press any key to close this window.
pause >nul
endlocal
