@echo off
REM ── 테스트용: 로그가 보이는 창으로 실행 ──
set RAILWAY_URL=https://music-mixer.up.railway.app
set WORKER_TOKEN=

cd /d "%~dp0"
python worker.py
pause
