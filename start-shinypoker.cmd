@echo off
REM ShinyPoker — start the dealer bot + the static frontend together.
REM Double-click this file. Two windows open; keep them open while you play.
REM Then open http://localhost:8080/poker/table.html in two browsers.
cd /d "%~dp0"
echo Starting ShinyPoker dealer bot + frontend...
start "ShinyPoker Dealer Bot" cmd /k node scripts/poker-dealer-bot.js
start "ShinyPoker Frontend (http://localhost:8080)" cmd /k node scripts/_dev-frontend.js
echo.
echo  Lobby:  http://localhost:8080/poker/lobby.html
echo  Table:  http://localhost:8080/poker/table.html?t=0
echo.
echo Keep both windows open while playing. Close them to stop.
pause
