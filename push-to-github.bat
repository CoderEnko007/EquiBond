@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title EquiBond - push to GitHub

echo ============================================================
echo   EquiBond  -  push local repo to GitHub
echo ============================================================
echo.
echo   Remote: https://github.com/CoderEnko007/EquiBond
echo.
echo   第一次运行会弹出 GitHub 授权页面（浏览器），点 Authorize 即可。
echo   授权后会自动推送，之后本脚本可用于同步更新。
echo.

set "GITEXE="
if exist "G:\AI\WorkBuddy\resources\vendor\PortableGit\cmd\git.exe" (
  set "GITEXE=G:\AI\WorkBuddy\resources\vendor\PortableGit\cmd\git.exe"
)
if not defined GITEXE (
  if exist "%USERPROFILE%\.workbuddy\binaries\PortableGit\versions\1.3.0\cmd\git.exe" (
    set "GITEXE=%USERPROFILE%\.workbuddy\binaries\PortableGit\versions\1.3.0\cmd\git.exe"
  )
)
if not defined GITEXE (
  where git >nul 2>nul && set "GITEXE=git"
)
if not defined GITEXE (
  echo [x] Git not found. Install Git for Windows, or upload files manually
  echo     on the GitHub web page.
  pause
  exit /b 1
)

echo [1/2] pushing main ...
"%GITEXE%" push -u origin main
if errorlevel 1 (
  echo.
  echo [x] Push failed. Check the message above.
  echo     If it says "Permission denied", the GitHub authorization was cancelled -
  echo     run this script again and click Authorize.
  pause
  exit /b 1
)

echo.
echo [2/2] done. Repository:
echo     https://github.com/CoderEnko007/EquiBond
echo.
echo   Next: enable GitHub Pages once (only needed the first time):
echo     Settings - Pages - Source: Deploy from a branch - main - / (root) - Save
echo     Then wait about 1 minute: https://coderenko007.github.io/EquiBond/
echo.
pause
