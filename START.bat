@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "PORT=8765"
set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY where python >nul 2>&1 && set "PY=python"
if not defined PY (
  echo [ERROR] 未找到 Python。请先安装并勾选 Add to PATH，或安装后重开终端。
  pause
  exit /b 1
)

REM Find a free port starting at 8765 (another app may already own 8765).
:find_port
powershell -NoProfile -Command "try { $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',!PORT!); $c.Close(); exit 1 } catch { exit 0 }" >nul 2>&1
if errorlevel 1 (
  echo [WARN] 端口 !PORT! 已被占用，尝试下一个...
  set /a PORT+=1
  if !PORT! GTR 8780 (
    echo [ERROR] 8765-8780 均被占用，请先关闭占用进程后重试。
    echo 可用命令查看: netstat -ano ^| findstr ":8765"
    pause
    exit /b 1
  )
  goto find_port
)

echo.
echo Starting IR-02 annotator at http://127.0.0.1:!PORT!/annotator/
echo Serving directory: %CD%
echo Press Ctrl+C to stop.
echo.

REM Open browser after the server has a moment to bind.
start "" cmd /c "timeout /t 1 /nobreak >nul & start http://127.0.0.1:!PORT!/annotator/"

%PY% -m http.server !PORT! --bind 127.0.0.1 --directory "%CD%"
if errorlevel 1 (
  echo.
  echo [ERROR] 启动失败。若提示 Address already in use，请换端口或结束占用进程。
  pause
  exit /b 1
)
