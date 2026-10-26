@echo off
setlocal
cd /d "%~dp0"
title EquiBond - push to GitHub

set "REPO_URL=https://github.com/CoderEnko007/EquiBond.git"

echo ============================================================
echo   EquiBond  -  push local repo to GitHub
echo ============================================================
echo   Remote: %REPO_URL%
echo.

rem ---------- 1. locate git ----------
set "GITEXE="
if exist "G:\AI\WorkBuddy\resources\vendor\PortableGit\cmd\git.exe" set "GITEXE=G:\AI\WorkBuddy\resources\vendor\PortableGit\cmd\git.exe"
if not defined GITEXE if exist "%USERPROFILE%\.workbuddy\binaries\PortableGit\versions\1.3.0\cmd\git.exe" set "GITEXE=%USERPROFILE%\.workbuddy\binaries\PortableGit\versions\1.3.0\cmd\git.exe"
if not defined GITEXE where git >nul 2>nul && set "GITEXE=git"
if not defined GITEXE (
  echo [x] Git for Windows not found. Install it first:
  echo     https://git-scm.com/download/win
  pause
  exit /b 1
)
echo [1/4] git: %GITEXE%

rem ---------- 2. auto-detect local proxy ----------
rem  Browsers reach GitHub through a PAC file, but git does not read PAC.
rem  Probe the common local proxy ports, first listening one wins.
set "PROXY="
for %%P in (10809 7897 7890 1080 8889 8080 2080) do (
  if not defined PROXY (
    netstat -ano ^| findstr ":%%P " ^| findstr "LISTENING" >nul 2>nul
    if not errorlevel 1 set "PROXY=http://127.0.0.1:%%P"
  )
)
if defined PROXY (
  echo [2/4] proxy: %PROXY%
  "%GITEXE%" config --local http.proxy "%PROXY%"
  "%GITEXE%" config --local https.proxy "%PROXY%"
  set "HTTP_PROXY=%PROXY%"
  set "HTTPS_PROXY=%PROXY%"
) else (
  echo [2/4] no local proxy found, trying direct connection
  "%GITEXE%" config --local --unset http.proxy >nul 2>nul
  "%GITEXE%" config --local --unset https.proxy >nul 2>nul
)

rem ---------- 3. connectivity check ----------
echo [3/4] checking connection to github.com ...
"%GITEXE%" ls-remote --heads origin >nul 2>nul
if errorlevel 1 (
  echo.
  echo [x] Cannot reach github.com.
  echo     If you use a VPN / proxy client, start it first, then run again.
  echo     If it uses a non-standard port, set it manually:
  echo         git config --local http.proxy http://127.0.0.1:PORT
  echo.
  pause
  exit /b 1
)

rem ---------- 4. push ----------
echo [4/4] pushing main ...
echo.
"%GITEXE%" push -u origin main
if errorlevel 1 (
  echo.
  echo [x] Push failed. See the message above.
  echo     "Permission denied" means authorization was cancelled -
  echo     run this script again and click Authorize in the browser.
  pause
  exit /b 1
)

echo.
echo ------------------------------------------------------------
echo   Done. Repo: %REPO_URL%
echo.
echo   Enable Pages once (first time only):
echo     Settings - Pages - Source: Deploy from a branch
echo     Branch: main   Folder: / (root)   -^>  Save
echo     Site: https://coderenko007.github.io/EquiBond/
echo ------------------------------------------------------------
echo.
pause
