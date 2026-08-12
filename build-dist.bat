@echo off
rem בניית תיקיית ההפצה: shiurim-station.exe + תיקיית app
cd /d "%~dp0"

echo [1/3] בניית המעטפת (KosherShell)...
set DOTNET=%USERPROFILE%\.dotnet\dotnet.exe
if not exist "%DOTNET%" set DOTNET=dotnet
"%DOTNET%" publish shell\KosherShell -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o dist\build-tmp || goto :err

echo [2/3] הרכבת תיקיית dist...
if exist dist\app rmdir /s /q dist\app
mkdir dist\app
copy server.js dist\app\ > nul
xcopy /e /i /q lib dist\app\lib > nul
xcopy /e /i /q public dist\app\public > nul
copy config.json dist\app\ > nul 2>nul
copy start-explorer.bat dist\app\ > nul
copy start-station.bat dist\app\ > nul
copy dist\build-tmp\KosherShell.exe "dist\shiurim-station.exe" > nul
rmdir /s /q dist\build-tmp

echo.
echo [3/3] סיום! ההפצה בתיקיית dist:
echo   dist\shiurim-station.exe  - מעטפת חלון (מסך מלא)
echo   dist\app\              - התוכנה (server.js + ממשק)
echo.
echo הפעלה:  dist\shiurim-station.exe --explorer
echo          dist\shiurim-station.exe --station
goto :eof

:err
echo.
echo שגיאה בבנייה — ודאו ש-.NET SDK מותקן (dotnet --version).
exit /b 1
