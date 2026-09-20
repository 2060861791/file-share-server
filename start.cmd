@echo off
title File Share Server

cd /d "%~dp0"

:: Check if node is available
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [X] Node.js not found. Please install Node.js first.
    echo     Download: https://nodejs.org
    pause
    exit /b 1
)

:: The shared folder lives outside the project, configured via SHARE_DIR.
:: Warn if neither .env nor SHARE_DIR is set, otherwise /srv/... is used.
if not exist ".env" if not defined SHARE_DIR (
    echo [!] No .env file and no SHARE_DIR variable found.
    echo     Copy .env.example to .env and set SHARE_DIR first, for example:
    echo         SHARE_DIR=D:/file-share/files
    echo.
)

echo.
echo   Starting file share server...
echo.
node index.js

pause
