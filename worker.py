"""집 PC에서 도는 추출 워커.

Railway 큐를 주기적으로 확인 → 유튜브 링크가 있으면 yt-dlp로 추출(집 IP라 봇 차단 안 걸림)
→ 결과 mp3를 Railway로 업로드. PC가 켜져 있는 동안만 동작한다.

실행 전 한 번만 설정:
  - RAILWAY_URL : 배포한 Railway 주소 (예: https://music-mixer.up.railway.app)
  - WORKER_TOKEN: Railway 환경변수 WORKER_TOKEN 과 같은 값 (선택, 보안용)
환경변수로 넣거나 아래 상수를 직접 고쳐도 된다.
"""

import logging
import os
import shutil
import sys
import tempfile
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path

import httpx
import yt_dlp

# Windows cmd 한글 깨짐 방지.
# pythonw(창 없음)에서는 sys.stdout이 None이라 여기서 반드시 예외가 나는데,
# 그 경우 콘솔 자체가 없으므로 무시하는 게 맞다 (제거하면 pythonw에서 시작 즉시 크래시).
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# ── 설정 ─────────────────────────────────────────
RAILWAY_URL = os.environ.get("RAILWAY_URL", "https://music-mixer.up.railway.app").rstrip("/")
WORKER_TOKEN = os.environ.get("WORKER_TOKEN", "")
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "5"))  # 초

# ── 로깅 ─────────────────────────────────────────
# pythonw로 돌면 print가 전부 사라지므로(stdout 없음) 파일에 기록하는 게 유일한 흔적이다.
LOG_FILE = Path(__file__).resolve().parent / "worker.log"


def _setup_logging() -> logging.Logger:
    logger = logging.getLogger("worker")
    logger.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S")
    fh = RotatingFileHandler(LOG_FILE, maxBytes=1_000_000, backupCount=2, encoding="utf-8")
    fh.setFormatter(fmt)
    logger.addHandler(fh)
    if sys.stdout is not None:  # 디버그 실행(run_worker_debug.bat)일 때만 콘솔에도 출력
        sh = logging.StreamHandler(sys.stdout)
        sh.setFormatter(fmt)
        logger.addHandler(sh)
    return logger


log = _setup_logging()


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


def _report_fail(qid: str, error: str):
    try:
        httpx.post(f"{RAILWAY_URL}/api/queue/{qid}/fail",
                   params={"token": WORKER_TOKEN}, data={"error": error}, timeout=30)
    except Exception as e:
        # 보고까지 실패하면 서버 큐는 '처리 중'으로 남아 10분 뒤에야 재시도됨 — 흔적은 남긴다
        log.warning("실패 보고도 실패 (queue_id=%s): %s", qid, e)


def process(job: dict):
    qid, url = job["queue_id"], job["url"]
    log.info("추출 시작: %s", url)
    with tempfile.TemporaryDirectory() as tmp:
        try:
            mp3, title, duration = extract(url, Path(tmp))
        except Exception as e:
            log.error("추출 실패 (%s): %s", url, e)
            _report_fail(qid, f"추출 실패: {e}")
            return

        try:
            with open(mp3, "rb") as f:
                r = httpx.post(
                    f"{RAILWAY_URL}/api/upload",
                    files={"file": (f"{title}.mp3", f, "audio/mpeg")},
                    data={"title": title, "duration": str(duration) if duration else "",
                          "queue_id": qid, "token": WORKER_TOKEN},
                    timeout=180,
                )
            if r.status_code == 410:
                log.info("취소됨 (사용자가 대기열에서 취소): %s", title)
                return
            r.raise_for_status()
        except Exception as e:
            log.error("업로드 실패 (%s): %s", title, e)
            _report_fail(qid, f"업로드 실패: {e}")
            return
    log.info("완료: %s", title)


def main():
    log.info("워커 시작 → %s (폴링 %d초, 로그: %s)", RAILWAY_URL, POLL_INTERVAL, LOG_FILE)
    if FFMPEG_LOCATION:
        log.info("ffmpeg: %s", FFMPEG_LOCATION)
    while True:
        try:
            r = httpx.get(f"{RAILWAY_URL}/api/queue/next", params={"token": WORKER_TOKEN}, timeout=30)
            job = r.json() if r.status_code == 200 else {}
        except Exception as e:
            log.warning("연결 오류: %s", e)
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
