"""music-mixer-app backend"""

import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import uuid
from pathlib import Path

import httpx

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import yt_dlp
from pytubefix import YouTube

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
RAILWAY_RELAY_URL = os.environ.get("RAILWAY_RELAY_URL", "").rstrip("/")

def _relay_to_railway(mp3_path: Path, title: str):
    if not RAILWAY_RELAY_URL:
        return
    try:
        with open(mp3_path, "rb") as f:
            with httpx.Client(timeout=120) as client:
                client.post(
                    f"{RAILWAY_RELAY_URL}/api/upload",
                    files={"file": (f"{title}.mp3", f, "audio/mpeg")},
                )
    except Exception:
        pass

def _get_cookies_file() -> str | None:
    b64 = os.environ.get("YT_COOKIES_B64")
    if not b64:
        return None
    try:
        content = base64.b64decode(b64).decode("utf-8")
        f = tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False)
        f.write(content)
        f.close()
        return f.name
    except Exception:
        return None


def _find_ffmpeg() -> Path | None:
    """시스템 PATH 우선, 없으면 Windows winget 경로 탐색."""
    if shutil.which("ffmpeg"):
        return None  # PATH에 있으면 yt-dlp가 자동으로 찾음
    base = Path.home() / "AppData/Local/Microsoft/WinGet/Packages"
    for pkg in base.glob("Gyan.FFmpeg_*"):
        for build in sorted(pkg.glob("ffmpeg-*-full_build"), reverse=True):
            bin_dir = build / "bin"
            if (bin_dir / "ffmpeg.exe").exists():
                return bin_dir
    return None


FFMPEG_LOCATION = _find_ffmpeg()

app = FastAPI(title="Music Mixer")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

def _load_tracks() -> dict:
    if TRACKS_FILE.exists():
        try:
            return json.loads(TRACKS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}

def _save_tracks():
    TRACKS_FILE.write_text(json.dumps(TRACKS, ensure_ascii=False, indent=2), encoding="utf-8")

TRACKS: dict[str, dict] = _load_tracks()

YOUTUBE_URL_RE = re.compile(
    r"^(https?://)?(www\.)?(youtube\.com|youtu\.be|m\.youtube\.com)/.+"
)


class ExtractRequest(BaseModel):
    url: str


@app.post("/api/extract")
def extract_audio(req: ExtractRequest):
    url = req.url.strip()
    if not url or not YOUTUBE_URL_RE.match(url):
        raise HTTPException(status_code=400, detail="유효한 유튜브 링크를 입력해주세요.")

    track_id = uuid.uuid4().hex[:12]
    out_template = str(DOWNLOAD_DIR / f"{track_id}.%(ext)s")
    ffmpeg_bin = str(FFMPEG_LOCATION / "ffmpeg") if FFMPEG_LOCATION else "ffmpeg"
    info = None

    # 1차: cobalt.tools API
    try:
        with httpx.Client(timeout=60) as client:
            resp = client.post(
                "https://api.cobalt.tools/",
                json={"url": url, "downloadMode": "audio", "audioFormat": "mp3", "audioBitrate": "192"},
                headers={"Accept": "application/json", "Content-Type": "application/json"},
            )
            data = resp.json()
        stream_url = data.get("url")
        if stream_url and data.get("status") in ("stream", "redirect", "tunnel"):
            with httpx.Client(timeout=120, follow_redirects=True) as client:
                r = client.get(stream_url)
                r.raise_for_status()
            mp3_path = DOWNLOAD_DIR / f"{track_id}.mp3"
            mp3_path.write_bytes(r.content)
            title = data.get("filename", "Untitled").removesuffix(".mp3")
            info = {"title": title, "duration": None}
    except Exception:
        pass

    # 2차: yt-dlp fallback
    if info is None:
        base_opts = {
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "extractor_args": {"youtube": {"player_client": ["android_music", "android", "tv_embedded"]}},
        }
        cookies = _get_cookies_file()
        if cookies:
            base_opts["cookiefile"] = cookies
        if FFMPEG_LOCATION:
            base_opts["ffmpeg_location"] = str(FFMPEG_LOCATION)
        try:
            with yt_dlp.YoutubeDL(base_opts) as ydl:
                meta = ydl.extract_info(url, download=False)
            formats = meta.get("formats", [])
            audio_only = [f for f in formats if f.get("vcodec") in (None, "none") and f.get("acodec") not in (None, "none")]
            chosen = sorted(audio_only, key=lambda f: f.get("abr") or 0, reverse=True) or \
                     sorted(formats, key=lambda f: f.get("tbr") or 0, reverse=True)
            if not chosen:
                raise yt_dlp.utils.DownloadError("포맷 없음")
            ydl_opts = {**base_opts, "format": chosen[0]["format_id"], "outtmpl": out_template,
                        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}]}
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=True)
        except yt_dlp.utils.DownloadError as e:
            raise HTTPException(status_code=400, detail=f"오디오 추출 실패: {e}")

    mp3_path = DOWNLOAD_DIR / f"{track_id}.mp3"
    if not mp3_path.exists():
        raise HTTPException(status_code=500, detail="오디오 파일 생성에 실패했습니다.")

    title = info.get("title", "Untitled") if isinstance(info, dict) else "Untitled"
    duration = info.get("duration") if isinstance(info, dict) else None

    TRACKS[track_id] = {
        "id": track_id,
        "title": title,
        "duration": duration,
        "filename": mp3_path.name,
    }
    _save_tracks()

    # Railway로 백그라운드 릴레이
    threading.Thread(target=_relay_to_railway, args=(mp3_path, title), daemon=True).start()

    return {
        "id": track_id,
        "title": title,
        "duration": duration,
        "stream_url": f"/api/audio/{track_id}",
        "download_url": f"/api/audio/{track_id}?download=1",
    }


@app.post("/api/upload")
async def upload_audio(file: UploadFile = File(...)):
    ext = Path(file.filename).suffix.lower()
    if ext not in {".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"}:
        raise HTTPException(status_code=400, detail="지원하지 않는 파일 형식입니다.")

    track_id = uuid.uuid4().hex[:12]
    dest = DOWNLOAD_DIR / f"{track_id}{ext}"
    content = await file.read()
    dest.write_bytes(content)

    title = Path(file.filename).stem
    TRACKS[track_id] = {
        "id": track_id,
        "title": title,
        "duration": None,
        "filename": dest.name,
    }
    _save_tracks()

    return {
        "id": track_id,
        "title": title,
        "duration": None,
        "stream_url": f"/api/audio/{track_id}",
        "download_url": f"/api/audio/{track_id}?download=1",
    }


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
