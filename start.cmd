@echo off
title File Share Server

cd /d "%~dp0"

:: Check if file directory exists
if not exist "file\" (
    echo [!] file folder not found, creating...
    mkdir file
)

:: Check if node is available
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [X] Node.js not found. Please install Node.js first.
    echo     Download: https://nodejs.org
    pause
    exit /b 1
)

echo.
echo   Starting file share server...
echo.
node index.js

pause
