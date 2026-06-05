@echo off
REM ShinyLuck backend launcher (self-healing supervisor). Guarded so a
REM scheduled-task / double-launch can't bind-conflict on port 8080: if the
REM stack is already serving, just exit. Used by the "ShinyLuck-Backend"
REM scheduled task for boot persistence ("never stops").
cd /d "D:\Рабочий стол\ShinyLuck"
netstat -ano | findstr ":8080 " | findstr LISTENING >nul 2>&1 && (echo [launcher] already running, skipping & exit /b 0)
echo [launcher] starting supervised backend...
call npm run play
