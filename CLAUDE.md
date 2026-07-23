# 뮤직믹서 — 프로젝트 핸드오프 문서

> 다른 세션/Claude Code가 이 프로젝트를 이어받을 때 필요한 맥락. 결정 사항과 이유, 아직 안 정한 것을 구분해서 적어둠.

## 1. 한 줄 요약

유튜브 링크 → mp3 추출 → 믹서(타임라인 편집)·턴테이블(DJ)·샘플러 패드·플레이리스트로 갖고 노는 웹 앱. 아이패드/폰 터치 조작이 핵심 타깃. Railway에 배포돼 있고, 무거운 작업(유튜브 추출, 스템 분리)은 집 PC 워커가 담당.

## 2. 아키텍처 — 왜 이렇게 나뉘었는지

```
아이패드/폰/PC 브라우저
      │  (HTTP)
      ▼
Railway (backend/main.py, FastAPI + 정적 프론트)
  - 트랙/큐/플레이리스트 저장 (DATA_DIR 볼륨)
  - 추출/스템분리는 "큐에 등록"만 함, 실행은 안 함
      │  (폴링, 5초 간격)
      ▼
집 PC 워커 (worker.py, pythonw로 백그라운드 상시 실행)
  - type=extract  → yt-dlp로 유튜브 추출 → /api/upload
  - type=separate → demucs(htdemucs_ft)로 스템 분리 → /api/tracks/{id}/stems
```

**핵심 제약 — 왜 클라우드에서 직접 안 하는지:**
- **유튜브 추출**: Railway 등 클라우드 데이터센터 IP는 유튜브 봇 감지에 걸림 (PO token). 로컬(집 IP)에서만 안정적. cobalt.tools 공개 API도 시도했으나 2025년 중반부터 유튜브 막힘 → 로컬 워커가 유일한 해법.
- **스템 분리(Demucs)**: CPU 집약적(htdemucs_ft 기준 곡당 10분+, RAM 수GB). Railway Hobby($5) 크레딧을 금방 넘기고 속도도 이득 없음 → 집 PC(Core Ultra 7)에서 처리.

## 3. 디렉터리 구조

```
backend/main.py       FastAPI 백엔드 (Railway에 배포됨)
worker.py              집 PC 상시 워커 (추출 + 스템분리)
frontend/              정적 프론트 (빌드 스텝 없음, 순수 JS/CSS/HTML)
  index.html, app.js, style.css
mlenv/                 워커 전용 venv — torch/demucs (gitignore, 무거움)
run_worker.bat          부팅 시 자동실행용 (창 없음, pythonw)
run_worker_debug.bat    테스트용 (창 보임, 로그 콘솔 출력)
worker.log              워커 로그 (pythonw는 stdout이 없어 파일 로깅 필수)
```

## 4. 반드시 알아야 할 함정

### DATA_DIR / Railway Volume — 아주 중요
`backend/main.py`는 `DATA_DIR` 환경변수가 없으면 `/tmp`를 쓰는데, **Railway는 재배포마다 컨테이너를 통째로 새로 만들어서 `/tmp`가 매번 삭제됨**. 즉 Volume을 안 붙이면 배포할 때마다 곡/플레이리스트가 전부 증발함 (실제로 한 번 겪음, 트랙 0개 확인됨).
- 해결: Railway 대시보드에서 Volume 생성 → music 서비스에 mount path `/data`로 연결 → 그 서비스의 **Variables**(프로젝트 공용 Shared Variables 아님)에 `DATA_DIR=/data` 추가.
- 이 설정이 빠지면 서버 시작 로그에 큰 경고가 뜨도록 코드에 이미 넣어둠 (`main.py` 상단, `DATA_DIR` 체크).
- **작업 시점 상태**: 사용자가 Volume 생성 + Variables 설정 진행 중이었음 — 이어받는 세션은 Railway 로그에 저 경고가 뜨는지부터 확인할 것.

### 워커 실행 시 PATH 오염 주의
VS Code가 이 워크스페이스의 `mlenv`(ML 전용 venv)를 터미널에 자동 활성화해서, bare `python`/`pythonw` 명령이 **mlenv로 잘못 잡히는 경우가 있음** (mlenv엔 yt_dlp/httpx가 없어서 추출 워커가 시작조차 안 됨). 그래서 `run_worker.bat`/`run_worker_debug.bat`은 파이썬 절대경로(`%LOCALAPPDATA%\Microsoft\WindowsApps\python(w).exe`)를 명시함 — 이 관례를 깨지 말 것. `worker.py`의 `ML_PYTHON`(demucs용)도 마찬가지로 자기 파일 위치 기준 절대경로로 계산됨.

### 캐시버스팅
`frontend/index.html`의 `app.js?v=N`, `style.css?v=N` — JS/CSS를 고치면 **반드시 버전 숫자를 올릴 것** (Railway 캐시 헤더가 immutable이라 안 올리면 브라우저가 옛날 파일을 계속 씀). 현재 v=18.

### 빌드 스텝 없음
프론트는 순수 JS(app.js 하나에 다 있음, ~2500줄+)/CSS/HTML. 문법 검사는 임시로 만든 괄호 균형 검사 스크립트(대화 중 scratchpad에 즉석 생성, 레포에 없음)로 함 — node가 로컬에 없어서.

### git push
이 세션에서 사용자가 git push 권한을 에이전트에게 허용함(`.claude` 설정) — 커밋 후 바로 push까지 하는 흐름으로 진행 중.

## 5. 현재 기능 상태 (2026-07-23 기준)

- **추출**: 유튜브 링크 → 큐 등록 → 워커 처리 → 라이브러리. 파일 업로드도 가능. 곡 제목 편집(✏) 가능.
- **믹서**: 타임라인에 블록 배치, 드래그=이동, 양끝 핸들=트림, ✂ 버튼으로 재생선 위치에서 블록 분할(가위 방식, 곱 여러 조각 허용). SNAP은 비트 격자 + 다른 블록 가장자리 자석. WAV/MP3 내보내기.
- **턴테이블**: 스크래치(감도 조절 가능), Key Lock(WSOLA, 조각 병렬처리로 고속화, 배속별 캐시), SYNC, EQ/필터/에코/리버브(WET·DECAY·PREDELAY), 루프, 핫큐, 파형 탭/드래그 시크, 두 손가락 동시 조작 지원.
- **패드(샘플러)**: 9개 패드, 믹서에서 트림한 구간을 패드로 보내기(P 버튼) 가능, 설정(⚙/길게누르기)에서 볼륨/피치/모드.
- **플레이리스트**: 서버 저장, 이름 있는 여러 개 생성 가능, 한 곡을 여러 플리에 동시 소속 가능, 플리 삭제해도 곡(최근 추출)은 유지.
- **스템 분리** (온디맨드, 버튼 눌러야만 동작): Demucs `htdemucs_ft`(고품질, 곡당 10분+)로 보컬/드럼/베이스/멜로디 4트랙 분리. 분리 완료 시 "스템 분리" 버튼이 펼치기/접기 토글로 바뀜(기본 접힘). 각 스템은 라이브러리의 정식 자식 트랙(`{id}_vocals` 등)이라 재생/믹서/패드/플리 다 됨.
- **스템 합치기**: 원하는 스템만 체크박스로 골라(예: 드럼+보컬만) 브라우저에서 바로 합쳐 새 곡으로 저장 — 워커/큐 없이 동작, 집 PC 꺼져 있어도 됨.

## 6. 알려진 한계

- 스템 분리는 시간이 오래 걸림(고품질 모델 기준 곡당 10분+) — 워커가 순차 처리라 그동안 추출도 대기.
- 볼륨 자동화(믹서 Alt+클릭 페이드) 등은 터치 UI 미지원으로 범위 밖에 남겨둠.
- MIDI 채보(오디오→음표) 기능은 논의만 하고 범위에서 제외 — 스템 분리까지만 구현.

## 7. 참고 커밋

- `a1bc1a1` — "baseline before AI refactor" (리팩토링 시작점, 문제 생기면 여기로 비교)
- 최신 커밋은 `git log --oneline`으로 확인. 커밋 메시지에 각 변경의 이유가 비교적 상세히 적혀 있음.
