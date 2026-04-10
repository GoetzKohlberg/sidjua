@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title SIDJUA Stop

echo.
echo  ┌─────────────────────────────────────────┐
echo  │  SIDJUA — AI Agent Governance Platform  │
echo  │  Stopping...                            │
echo  └─────────────────────────────────────────┘
echo.

:: ------------------------------------------------------------
:: 1. Check Docker is installed
:: ------------------------------------------------------------
where docker >nul 2>&1
if %errorlevel% neq 0 (
    echo  Docker Desktop is not installed.
    echo  Nothing to stop.
    echo.
    pause
    exit /b 0
)

:: ------------------------------------------------------------
:: 2. Stop SIDJUA
:: ------------------------------------------------------------
echo  Stopping SIDJUA...
docker compose down

if %errorlevel% equ 0 (
    echo.
    echo  SIDJUA stopped.
) else (
    echo.
    echo  SIDJUA was not running or could not be stopped.
)

echo.
pause
exit /b 0
