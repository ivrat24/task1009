@echo off
REM Full transfer pack: annotator UI + vendor + full cleaned corpus (sessions.jsonl).
REM Skips sessions.js to avoid duplicating ~140MB.
cd /d "%~dp0.."
set OUT=portable_ir02_full
set ZIP=portable_ir02_full.zip

if not exist "data\cleaned\sessions.jsonl" (
  echo ERROR: data\cleaned\sessions.jsonl missing. Run import first.
  exit /b 1
)

echo Building %OUT% ...
if exist "%OUT%" rmdir /s /q "%OUT%"
if exist "%ZIP%" del /f /q "%ZIP%"

mkdir "%OUT%"
mkdir "%OUT%\annotator"
mkdir "%OUT%\data"
mkdir "%OUT%\data\cleaned"
mkdir "%OUT%\labels"
mkdir "%OUT%\scripts"

xcopy /e /i /y "annotator\*" "%OUT%\annotator\" >nul
copy /y "data\cleaned\sessions.jsonl" "%OUT%\data\cleaned\" >nul
copy /y "data\cleaned\index.json" "%OUT%\data\cleaned\" >nul
if exist "data\cleaned\sessions_sample100.jsonl" copy /y "data\cleaned\sessions_sample100.jsonl" "%OUT%\data\cleaned\" >nul
if exist "data\cleaned\sessions_sample100.js" copy /y "data\cleaned\sessions_sample100.js" "%OUT%\data\cleaned\" >nul
if exist "data\cleaned\index_sample100.json" copy /y "data\cleaned\index_sample100.json" "%OUT%\data\cleaned\" >nul
copy /y "START.bat" "%OUT%\" >nul
copy /y "README.md" "%OUT%\" >nul

> "%OUT%\PORTABLE.txt" (
  echo IR-02 完整转移包（含全库）
  echo.
  echo 内容：打标界面 + vendor + data\cleaned\sessions.jsonl（全库约 5795 会话）
  echo.
  echo 使用：
  echo   1^) 解压后双击 START.bat
  echo   2^) 打开 http://127.0.0.1:8765/annotator/
  echo   3^) 页面会流式加载全库（需等待解析完成）
  echo.
  echo 标注进度：
  echo   - 浏览器 localStorage 不会随压缩包带走
  echo   - 转移前请点「导出我的标注」，把 JSON 放进 labels\
  echo   - 新机器「导入标注」恢复
  echo.
  echo 未包含 sessions.js（与 jsonl 重复且约 140MB）；界面默认读 sessions.jsonl。
)

echo Compressing %ZIP% (may take a few minutes)...
powershell -NoProfile -Command "Compress-Archive -Path '%OUT%\*' -DestinationPath '%ZIP%' -CompressionLevel Optimal -Force"
echo.
echo Done.
echo Folder: %CD%\%OUT%\
echo Zip:    %CD%\%ZIP%
dir "%ZIP%"
