@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title EquiBond - Mobile Access

echo ============================================================
echo   EquiBond  -  starting local server for phone access
echo ============================================================
echo.

set "PYEXE="
rem Prefer the bundled venv: it has qrcode, so the QR code can be printed.
if exist "%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe" (
  set "PYEXE=%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
)
if not defined PYEXE (
  where py >nul 2>nul && set "PYEXE=py -3"
)
if not defined PYEXE (
  where python >nul 2>nul && set "PYEXE=python"
)
if not defined PYEXE (
  echo [x] Python not found. Please install Python 3 and retry.
  pause
  exit /b 1
)

%PYEXE% scripts\serve.py %*

echo.
pause
