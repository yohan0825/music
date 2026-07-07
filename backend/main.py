"""music-mixer-app backend (Railway).

추출은 하지 않는다. 아이패드/PC가 유튜브 링크를 넣으면 큐에 쌓아두고,
집 PC에서 도는 worker.py가 큐를 폴링해 yt-dlp로 추출한 뒤 /api/upload로 올린다.
"""

import json
import logging
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


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("music-mixer")


def _load_json(path: Path, default):
    """JSON 로드. 깨진 파일은 .corrupt-시각으로 보존한다 —
    조용히 기본값으로 시작하면 다음 저장 때 깨진 원본을 덮어써 복구가 불가능해진다."""
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            backup = path.with_name(f"{path.name}.corrupt-{time.strftime('%Y%m%d-%H%M%S')}")
            log.exception("%s 파싱 실패 — %s로 보존하고 빈 데이터로 시작", path.name, backup.name)
            try:
                path.rename(backup)
            except OSError:
                log.exception("깨진 파일 백업 실패: %s", path)
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
        except Exception as e:
            # 제목은 부가 정보 — 실패해도 링크로 표시되지만, oEmbed가 막히기 시작하면 알아야 함
            log.warning("oEmbed 제목 조회 실패 (%s): %s", url, e)
    threading.Thread(target=run, daemon=True).start()


@app.post("/api/extract")
def enqueue_extract(req: ExtractRequest):
    """유튜브 링크를 추출 큐에 넣는다 (실제 추출은 집 PC 워커가 함)."""
    url = req.url.strip()
    if not url or not YOUTUBE_URL_RE.match(url):
        raise HTTPException(status_code=400, detail="유효한 유튜브 링크를 입력해주세요.")

    qid = uuid.uuid4().hex[:12]
    with _lock:
        QUEUE[qid] = {"id": qid, "type": "extract", "url": url,
                      "status": "pending", "title": None, "error": None}
        _save_queue()
    _fetch_title_async(qid, url)

    return {"queued": True, "queue_id": qid,
            "message": "추출 대기열에 추가됐어요. 집 PC가 켜져 있으면 곧 라이브러리에 나타나요."}


STEM_NAMES = ("vocals", "drums", "bass", "other")


@app.post("/api/tracks/{track_id}/separate")
def enqueue_separate(track_id: str):
    """트랙의 스템 분리를 큐에 넣는다 (요청한 트랙만, 실제 분리는 집 PC 워커)."""
    track = TRACKS.get(track_id)
    if not track:
        raise HTTPException(status_code=404, detail="트랙을 찾을 수 없습니다.")
    if track.get("stem_of"):
        raise HTTPException(status_code=400, detail="스템 트랙은 다시 분리할 수 없습니다.")
    status = track.get("stems", {}).get("status")
    if status in ("queued", "processing"):
        raise HTTPException(status_code=409, detail="이미 분리 작업이 진행 중입니다.")
    if status == "done":
        raise HTTPException(status_code=409, detail="이미 분리된 트랙입니다.")

    qid = uuid.uuid4().hex[:12]
    with _lock:
        QUEUE[qid] = {"id": qid, "type": "separate", "track_id": track_id,
                      "status": "pending", "title": f"{track['title']} (스템 분리)", "error": None}
        track["stems"] = {"status": "queued", "model": "htdemucs"}
        _save_queue()
        _save_tracks()
    return {"queued": True, "queue_id": qid,
            "message": "스템 분리 대기열에 추가됐어요. 곡 길이에 따라 몇 분 걸려요."}


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
                job_type = q.get("type", "extract")
                if job_type == "separate":
                    track = TRACKS.get(q.get("track_id", ""))
                    if track and "stems" in track:
                        track["stems"]["status"] = "processing"
                        _save_tracks()
                _save_queue()
                return {"queue_id": q["id"], "type": job_type,
                        "url": q.get("url"), "track_id": q.get("track_id")}
    return {}


@app.post("/api/queue/{qid}/fail")
def fail_queue(qid: str, token: str = Query(""), error: str = Form("")):
    """워커가 작업 실패를 보고한다."""
    _check_token(token)
    with _lock:
        q = QUEUE.get(qid)
        if q:
            q["status"] = "error"
            q["error"] = error[:300]
            # 스템 분리 실패면 트랙 상태에도 반영 (버튼이 '재시도'로 바뀌게)
            if q.get("type") == "separate":
                track = TRACKS.get(q.get("track_id", ""))
                if track and "stems" in track:
                    track["stems"]["status"] = "failed"
                    track["stems"]["error"] = error[:300]
                    _save_tracks()
            _save_queue()
    return {"ok": True}


@app.delete("/api/queue/{qid}")
def remove_queue(qid: str):
    """대기열 취소. 처리 중이던 작업도 취소되면 업로드가 거부된다(410)."""
    with _lock:
        q = QUEUE.pop(qid, None)
        # 분리 작업 취소면 트랙 상태를 되돌려 버튼이 다시 활성화되게
        if q and q.get("type") == "separate":
            track = TRACKS.get(q.get("track_id", ""))
            if track and track.get("stems", {}).get("status") in ("queued", "processing"):
                track.pop("stems", None)
                _save_tracks()
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
        if q.get("type") == "separate":
            track = TRACKS.get(q.get("track_id", ""))
            if track and "stems" in track:
                track["stems"]["status"] = "queued"
                _save_tracks()
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
        log.warning("duration 파싱 실패, None으로 처리: %r (title=%s)", duration, title)
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


@app.post("/api/tracks/{track_id}/stems")
async def upload_stems(
    track_id: str,
    vocals: UploadFile = File(...),
    drums: UploadFile = File(...),
    bass: UploadFile = File(...),
    other: UploadFile = File(...),
    queue_id: str = Form(""),
    token: str = Form(""),
):
    """워커가 분리 결과(스템 4개 mp3)를 올린다. 각 스템은 자식 트랙으로 등록돼
    기존 재생/믹서/패드 흐름을 그대로 탄다."""
    _check_token(token)
    track = TRACKS.get(track_id)
    if not track:
        raise HTTPException(status_code=404, detail="트랙을 찾을 수 없습니다.")
    if queue_id:
        with _lock:
            if queue_id not in QUEUE:
                raise HTTPException(status_code=410, detail="취소된 작업입니다.")

    stem_dir = DOWNLOAD_DIR / "stems" / track_id
    stem_dir.mkdir(parents=True, exist_ok=True)

    uploads = {"vocals": vocals, "drums": drums, "bass": bass, "other": other}
    files = {}
    with _lock:
        for stem, up in uploads.items():
            dest = stem_dir / f"{stem}.mp3"
            dest.write_bytes(await up.read())
            rel = str(dest.relative_to(DOWNLOAD_DIR)).replace("\\", "/")
            files[stem] = rel
            child_id = f"{track_id}_{stem}"
            TRACKS[child_id] = {
                "id": child_id,
                "title": f"{track['title']} · {stem}",
                "duration": track.get("duration"),
                "filename": rel,
                "stem_of": track_id,
                "stem": stem,
            }
        track["stems"] = {"status": "done", "model": "htdemucs", "files": files}
        if queue_id:
            QUEUE.pop(queue_id, None)
            _save_queue()
        _save_tracks()
    return {"ok": True, "stems": files}


@app.get("/api/tracks")
def list_tracks():
    return list(TRACKS.values())


class RenameRequest(BaseModel):
    title: str


@app.patch("/api/tracks/{track_id}")
def rename_track(track_id: str, req: RenameRequest):
    track = TRACKS.get(track_id)
    if not track:
        raise HTTPException(status_code=404, detail="트랙을 찾을 수 없습니다.")
    title = req.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="제목을 입력해주세요.")
    track["title"] = title[:200]
    _save_tracks()
    return track


def _delete_track_file(track: dict):
    file_path = DOWNLOAD_DIR / track["filename"]
    if file_path.exists():
        file_path.unlink()


@app.delete("/api/tracks/{track_id}")
def delete_track(track_id: str):
    track = TRACKS.pop(track_id, None)
    if not track:
        raise HTTPException(status_code=404, detail="트랙을 찾을 수 없습니다.")
    _delete_track_file(track)

    # 원곡 삭제 시 자식 스템 트랙·파일도 함께 삭제
    for child_id in [cid for cid, t in TRACKS.items() if t.get("stem_of") == track_id]:
        _delete_track_file(TRACKS.pop(child_id))

    # 스템 트랙을 개별 삭제하면 원곡의 stems 목록에서도 제거
    parent = TRACKS.get(track.get("stem_of", ""))
    if parent and "stems" in parent:
        parent["stems"].get("files", {}).pop(track.get("stem", ""), None)
        if not parent["stems"].get("files"):
            parent.pop("stems", None)  # 전부 지웠으면 다시 분리 가능하게

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

    # 트랙 파일은 id별로 불변이라 브라우저가 영구 캐시해도 안전 — 재방문 시 다운로드 생략
    cache_headers = {"Cache-Control": "public, max-age=31536000, immutable"}
    if download:
        safe_title = re.sub(r"[^\w\-. ]", "_", track["title"])[:80]
        return FileResponse(file_path, media_type="audio/mpeg",
                            filename=f"{safe_title}.mp3", headers=cache_headers)
    return FileResponse(file_path, media_type="audio/mpeg", headers=cache_headers)


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
