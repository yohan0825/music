"""music-mixer-app backend (Railway).

추출은 하지 않는다. 아이패드/PC가 유튜브 링크를 넣으면 큐에 쌓아두고,
집 PC에서 도는 worker.py가 큐를 폴링해 yt-dlp로 추출한 뒤 /api/upload로 올린다.
"""

import json
import os
import re
import threading
import time
import uuid
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"

# Railway Volume → DATA_DIR 환경변수 설정
# 로컬 Windows → backend/downloads
# 그 외 클라우드 임시 → /tmp/music_downloads
DATA_DIR = os.environ.get("DATA_DIR")
if DATA_DIR:
    DOWNLOAD_DIR = Path(DATA_DIR)
elif os.name == "nt":
    DOWNLOAD_DIR = BASE_DIR / "downloads"
else:
    DOWNLOAD_DIR = Path("/tmp/music_downloads")
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

TRACKS_FILE = DOWNLOAD_DIR / "tracks.json"
QUEUE_FILE = DOWNLOAD_DIR / "queue.json"

# 로컬 워커가 큐를 폴링할 때 쓰는 인증 토큰 (없으면 인증 생략)
WORKER_TOKEN = os.environ.get("WORKER_TOKEN", "")

app = FastAPI(title="Music Mixer")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_lock = threading.Lock()


def _load_json(path: Path, default):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return default


def _save_tracks():
    TRACKS_FILE.write_text(json.dumps(TRACKS, ensure_ascii=False, indent=2), encoding="utf-8")


def _save_queue():
    QUEUE_FILE.write_text(json.dumps(QUEUE, ensure_ascii=False, indent=2), encoding="utf-8")


TRACKS: dict[str, dict] = _load_json(TRACKS_FILE, {})
# QUEUE: qid -> {id, url, status: pending|processing|error, title, error}
QUEUE: dict[str, dict] = _load_json(QUEUE_FILE, {})

YOUTUBE_URL_RE = re.compile(
    r"^(https?://)?(www\.)?(youtube\.com|youtu\.be|m\.youtube\.com)/.+"
)


def _check_token(token: str):
    if WORKER_TOKEN and token != WORKER_TOKEN:
        raise HTTPException(status_code=401, detail="인증 실패")


class ExtractRequest(BaseModel):
    url: str


def _fetch_title_async(qid: str, url: str):
    """oEmbed로 영상 제목을 가져와 큐에 채운다 (봇 감지 없어 클라우드에서도 됨)."""
    def run():
        try:
            with httpx.Client(timeout=8, follow_redirects=True) as client:
                r = client.get("https://www.youtube.com/oembed",
                               params={"url": url, "format": "json"})
                title = r.json().get("title")
            if title:
                with _lock:
                    q = QUEUE.get(qid)
                    if q:
                        q["title"] = title
                        _save_queue()
        except Exception:
            pass  # 제목은 부가 정보 — 실패해도 링크로 표시됨
    threading.Thread(target=run, daemon=True).start()


@app.post("/api/extract")
def enqueue_extract(req: ExtractRequest):
    """유튜브 링크를 추출 큐에 넣는다 (실제 추출은 집 PC 워커가 함)."""
    url = req.url.strip()
    if not url or not YOUTUBE_URL_RE.match(url):
        raise HTTPException(status_code=400, detail="유효한 유튜브 링크를 입력해주세요.")

    qid = uuid.uuid4().hex[:12]
    with _lock:
        QUEUE[qid] = {"id": qid, "url": url, "status": "pending", "title": None, "error": None}
        _save_queue()
    _fetch_title_async(qid, url)

    return {"queued": True, "queue_id": qid,
            "message": "추출 대기열에 추가됐어요. 집 PC가 켜져 있으면 곧 라이브러리에 나타나요."}


@app.get("/api/queue")
def list_queue():
    """대기/처리 중인 항목 (UI 표시용)."""
    return [q for q in QUEUE.values() if q["status"] in ("pending", "processing", "error")]


# processing 상태로 이 시간(초) 넘게 방치된 작업은 워커가 죽은 것으로 보고 재시도
STALE_CLAIM_SEC = 600


@app.get("/api/queue/next")
def claim_next(token: str = Query("")):
    """워커가 다음 작업을 가져간다. 없으면 빈 응답."""
    _check_token(token)
    now = time.time()
    with _lock:
        for q in QUEUE.values():
            stale = q["status"] == "processing" and now - q.get("claimed_at", 0) > STALE_CLAIM_SEC
            if q["status"] == "pending" or stale:
                q["status"] = "processing"
                q["claimed_at"] = now
                _save_queue()
                return {"queue_id": q["id"], "url": q["url"]}
    return {}


@app.post("/api/queue/{qid}/fail")
def fail_queue(qid: str, token: str = Query(""), error: str = Form("")):
    """워커가 추출 실패를 보고한다."""
    _check_token(token)
    with _lock:
        q = QUEUE.get(qid)
        if q:
            q["status"] = "error"
            q["error"] = error[:300]
            _save_queue()
    return {"ok": True}


@app.delete("/api/queue/{qid}")
def remove_queue(qid: str):
    """대기열 취소. 처리 중이던 작업도 취소되면 업로드가 거부된다(410)."""
    with _lock:
        QUEUE.pop(qid, None)
        _save_queue()
    return {"ok": True}


@app.post("/api/queue/{qid}/move")
def move_queue(qid: str, dir: str = Query(...)):
    """대기열 순서를 한 칸 위/아래로 옮긴다."""
    if dir not in ("up", "down"):
        raise HTTPException(status_code=400, detail="dir은 up 또는 down이어야 합니다.")
    with _lock:
        keys = list(QUEUE.keys())
        if qid not in keys:
            raise HTTPException(status_code=404, detail="대기열에 없습니다.")
        i = keys.index(qid)
        j = i - 1 if dir == "up" else i + 1
        if 0 <= j < len(keys):
            keys[i], keys[j] = keys[j], keys[i]
            reordered = {k: QUEUE[k] for k in keys}
            QUEUE.clear()
            QUEUE.update(reordered)
            _save_queue()
    return {"ok": True}


@app.post("/api/queue/{qid}/retry")
def retry_queue(qid: str):
    """실패한 작업을 다시 대기 상태로 되돌린다."""
    with _lock:
        q = QUEUE.get(qid)
        if not q:
            raise HTTPException(status_code=404, detail="대기열에 없습니다.")
        q["status"] = "pending"
        q["error"] = None
        q.pop("claimed_at", None)
        _save_queue()
    return {"ok": True}


def _register_track(track_id: str, title: str, duration, filename: str):
    TRACKS[track_id] = {"id": track_id, "title": title, "duration": duration, "filename": filename}
    _save_tracks()
    return {
        "id": track_id,
        "title": title,
        "duration": duration,
        "stream_url": f"/api/audio/{track_id}",
        "download_url": f"/api/audio/{track_id}?download=1",
    }


@app.post("/api/upload")
async def upload_audio(
    file: UploadFile = File(...),
    title: str = Form(""),
    duration: str = Form(""),
    queue_id: str = Form(""),
    token: str = Form(""),
):
    """파일 업로드. 로컬 워커가 추출 결과를 올릴 때도 이 엔드포인트를 쓴다."""
    # 워커가 올리는 경우(queue_id 있음)만 토큰 검사
    if queue_id:
        _check_token(token)
        # 사용자가 처리 중에 취소한 작업이면 결과를 버린다
        with _lock:
            if queue_id not in QUEUE:
                raise HTTPException(status_code=410, detail="취소된 작업입니다.")

    # duration은 없을 수 있음(라이브 영상 등) — 파싱 실패해도 업로드는 진행
    try:
        parsed_duration = float(duration) if duration.strip() else None
    except ValueError:
        parsed_duration = None

    ext = Path(file.filename).suffix.lower()
    if ext not in {".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"}:
        raise HTTPException(status_code=400, detail="지원하지 않는 파일 형식입니다.")

    track_id = uuid.uuid4().hex[:12]
    dest = DOWNLOAD_DIR / f"{track_id}{ext}"
    content = await file.read()
    dest.write_bytes(content)

    resolved_title = title.strip() or Path(file.filename).stem
    result = _register_track(track_id, resolved_title, parsed_duration, dest.name)

    if queue_id:
        with _lock:
            QUEUE.pop(queue_id, None)
            _save_queue()

    return result


@app.get("/api/tracks")
def list_tracks():
    return list(TRACKS.values())


@app.delete("/api/tracks/{track_id}")
def delete_track(track_id: str):
    track = TRACKS.pop(track_id, None)
    if not track:
        raise HTTPException(status_code=404, detail="트랙을 찾을 수 없습니다.")
    file_path = DOWNLOAD_DIR / track["filename"]
    if file_path.exists():
        file_path.unlink()
    _save_tracks()
    return {"ok": True}


@app.get("/api/audio/{track_id}")
def get_audio(track_id: str, download: int = 0):
    track = TRACKS.get(track_id)
    if not track:
        raise HTTPException(status_code=404, detail="트랙을 찾을 수 없습니다.")

    file_path = DOWNLOAD_DIR / track["filename"]
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="파일이 존재하지 않습니다.")

    if download:
        safe_title = re.sub(r"[^\w\-. ]", "_", track["title"])[:80]
        return FileResponse(file_path, media_type="audio/mpeg", filename=f"{safe_title}.mp3")
    return FileResponse(file_path, media_type="audio/mpeg")


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
