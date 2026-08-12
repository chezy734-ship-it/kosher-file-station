@echo off
rem עמדת שיעורים — סייר קבצים מסונן (בחלון קיוסק מלא)
cd /d "%~dp0"
start /min node server.js
timeout /t 2 /nobreak > nul
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --kiosk-printing http://127.0.0.1:8787
