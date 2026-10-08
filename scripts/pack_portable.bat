@echo off
REM Build a portable zip that keeps annotator + sample data + vendor assets working offline.
cd /d "%~dp0.."
set OUT=portable_ir02_annotator
if exist "%OUT%" rmdir /s /q "%OUT%"
mkdir "%OUT%"
mkdir "%OUT%\annotator"
mkdir "%OUT%\annotator\vendor"
mkdir "%OUT%\data"
mkdir "%OUT%\data\cleaned"
mkdir "%OUT%\scripts"
mkdir "%OUT%\labels"

xcopy /e /i /y "annotator\*" "%OUT%\annotator\" >nul
xcopy /y "data\cleaned\sessions_sample100.js" "%OUT%\data\cleaned\" >nul
xcopy /y "data\cleaned\sessions_sample100.jsonl" "%OUT%\data\cleaned\" >nul
xcopy /y "data\cleaned\index_sample100.json" "%OUT%\data\cleaned\" >nul
xcopy /y "README.md" "%OUT%\" >nul
xcopy /y "START.bat" "%OUT%\" >nul
xcopy /y "scripts\normalize_transcripts.py" "%OUT%\scripts\" >nul
xcopy /y "scripts\import_swe_chat_parquet.py" "%OUT%\scripts\" >nul
xcopy /y "scripts\download_swe_chat.py" "%OUT%\scripts\" >nul

> "%OUT%\PORTABLE.txt" (
  echo IR-02 portable annotator
  echo.
  echo 1^) Double-click START.bat
  echo 2^) Open http://127.0.0.1:8765/annotator/
  echo 3^) Before moving machines: click "导出标注" and keep the JSON under labels\
  echo 4^) On the new machine: click "导入标注" to restore progress
  echo.
  echo Offline: KaTeX / marked / xlsx are under annotator\vendor\ ^(no CDN needed^).
  echo Full corpus ^(optional^): copy data\cleaned\sessions.jsonl separately if needed.
)

powershell -NoProfile -Command "Compress-Archive -Path '%OUT%\*' -DestinationPath 'portable_ir02_annotator.zip' -Force"
echo Packed: %CD%\portable_ir02_annotator\
echo Zip:    %CD%\portable_ir02_annotator.zip
