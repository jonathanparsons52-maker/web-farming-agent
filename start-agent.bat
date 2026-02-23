@echo off
title Web Farming Local Agent
echo.
echo  =========================================
echo   Web Farming Local Agent
echo  =========================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Node.js is not installed.
    echo  Please install Node.js from https://nodejs.org
    echo.
    pause
    exit /b 1
)

if not exist "%~dp0node_modules" (
    echo  Installing dependencies...
    cd /d "%~dp0"
    npm install
    echo.
)

cd /d "%~dp0"
node agent.js

if %errorlevel% neq 0 (
    echo.
    echo  Agent exited with an error.
    pause
)
