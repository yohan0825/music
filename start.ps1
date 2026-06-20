# Music Mixer 서버 실행 스크립트
$venvPython = Join-Path $PSScriptRoot "backend\venv\Scripts\python.exe"
Set-Location (Join-Path $PSScriptRoot "backend")
& $venvPython -m uvicorn main:app --host 127.0.0.1 --port 8000
