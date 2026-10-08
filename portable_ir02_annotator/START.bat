@echo off
cd /d "%~dp0"
echo Starting IR-02 annotator at http://127.0.0.1:8765/annotator/
echo Press Ctrl+C to stop.
start "" http://127.0.0.1:8765/annotator/
python -m http.server 8765 --bind 127.0.0.1
