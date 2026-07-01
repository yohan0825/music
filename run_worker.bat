@echo off
REM ── 집 PC 추출 워커 실행 ──
REM 아래 두 값만 본인 것으로 고치세요.
set RAILWAY_URL=https://music-mixer.up.railway.app
set WORKER_TOKEN=

cd /d "%~dp0"
pythonw worker.py
