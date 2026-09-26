@echo off
rem Amharic Captions - standalone SRT maker (no Premiere / After Effects needed).
rem Drag video or audio files onto this file (or its desktop shortcut); an .srt
rem appears next to each one. Uses the runtime installed with the panel.
setlocal
chcp 65001 >nul
title Amharic Captions - SRT
set "RT=%~dp0runtime"
if not exist "%RT%\python\python.exe" (
    echo Runtime not found. Run Install.cmd again.
    pause
    exit /b 1
)
"%RT%\python\python.exe" -E -s -X utf8 "%RT%\amh_standalone.py" %*
echo.
pause
endlocal
