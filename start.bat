@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

echo ============================================================
echo   EquiBond  -  updating data...
echo ============================================================
echo.

set "PYEXE="
where py >nul 2>nul && set "PYEXE=py -3"
if not defined PYEXE (
  where python >nul 2>nul && set "PYEXE=python"
)
if not defined PYEXE (
  if exist "%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe" (
    set "PYEXE=%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
  )
)
if not defined PYEXE (
  echo [x] Python not found. Please install Python 3 and retry.
  pause
  exit /b 1
)

%PYEXE% scripts\update.py %*

echo.
echo Opening browser...
start "" "%~dp0index.html"

timeout /t 4 >nul 2>&1
