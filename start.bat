@echo off
cd /d "%~dp0"
start "Navi-Toll Server" cmd /k npm start
timeout /t 3 /nobreak >nul
start "" http://localhost:3200
