"""집 PC에서 도는 추출 워커.

Railway 큐를 주기적으로 확인 → 유튜브 링크가 있으면 yt-dlp로 추출(집 IP라 봇 차단 안 걸림)
→ 결과 mp3를 Railway로 업로드. PC가 켜져 있는 동안만 동작한다.

실행 전 한 번만 설정:
  - RAILWAY_URL : 배포한 Railway 주소 (예: https://music-mixer.up.railway.app)
  - WORKER_TOKEN: Railway 환경변수 WORKER_TOKEN 과 같은 값 (선택, 보안용)
환경변수로 넣거나 아래 상수를 직접 고쳐도 된다.
"""

import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

import httpx
import yt_dlp

# Windows cmd 한글 깨짐 방지
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# ── 설정 ─────────────────────────────────────────
RAILWAY_URL = os.environ.get("RAILWAY_URL", "https://music-mixer.up.railway.app").rstrip("/")
WORKER_TOKEN = os.environ.get("WORKER_TOKEN", "")
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "5"))  # 초


def _find_ffmpeg() -> str | None:
    """시스템 PATH 우선, 없으면 Windows winget 설치 경로 탐색."""
    if shutil.which("ffmpeg"):
        return None  # PATH에 있으면 yt-dlp가 자동으로 찾음
    base = Path.home() / "AppData/Local/Microsoft/WinGet/Packages"
    for pkg in base.glob("Gyan.FFmpeg_*"):
        for build in sorted(pkg.glob("ffmpeg-*-full_build"), reverse=True):
            bin_dir = build / "bin"
            if (bin_dir / "ffmpeg.exe").exists():
                return str(bin_dir)
    return None


FFMPEG_LOCATION = _find_ffmpeg()


def extract(url: str, out_dir: Path) -> tuple[Path, str, float | None]:
    """yt-dlp로 오디오를 뽑아 mp3로 저장. (경로, 제목, 길이) 반환."""
    out_template = str(out_dir / "audio.%(ext)s")
    opts = {
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "format": "bestaudio/best",
        "outtmpl": out_template,
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}],
    }
    if FFMPEG_LOCATION:
        opts["ffmpeg_location"] = FFMPEG_LOCATION

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)

    mp3 = out_dir / "audio.mp3"
    if not mp3.exists():
        raise RuntimeError("mp3 파일이 생성되지 않았습니다 (ffmpeg 확인).")
    return mp3, info.get("title", "Untitled"), info.get("duration")


def process(job: dict):
    qid, url = job["queue_id"], job["url"]
    print(f"[추출] {url}")
    with tempfile.TemporaryDirectory() as tmp:
        try:
            mp3, title, duration = extract(url, Path(tmp))
        except Exception as e:
            print(f"[실패] {e}")
            try:
                httpx.post(f"{RAILWAY_URL}/api/queue/{qid}/fail",
                           params={"token": WORKER_TOKEN}, data={"error": str(e)}, timeout=30)
            except Exception:
                pass
            return

        with open(mp3, "rb") as f:
            httpx.post(
                f"{RAILWAY_URL}/api/upload",
                files={"file": (f"{title}.mp3", f, "audio/mpeg")},
                data={"title": title, "duration": duration or "", "queue_id": qid, "token": WORKER_TOKEN},
                timeout=180,
            )
    print(f"[완료] {title}")


def main():
    print(f"워커 시작 → {RAILWAY_URL} (폴링 {POLL_INTERVAL}초)")
    if FFMPEG_LOCATION:
        print(f"ffmpeg: {FFMPEG_LOCATION}")
    while True:
        try:
            r = httpx.get(f"{RAILWAY_URL}/api/queue/next", params={"token": WORKER_TOKEN}, timeout=30)
            job = r.json() if r.status_code == 200 else {}
        except Exception as e:
            print(f"[연결 오류] {e}")
            job = {}

        if job.get("url"):
            process(job)
        else:
            time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
