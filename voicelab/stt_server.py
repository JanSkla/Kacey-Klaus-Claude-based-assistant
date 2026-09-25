"""Persistent Whisper speech-to-text server for Kacey.

The bedside kiosk runs Epiphany (WebKitGTK), which has no working Web Speech
recognition — so the page records the utterance itself and sends it here.
faster-whisper (CTranslate2) holds the model in memory and answers over plain
HTTP; Kacey's /api/stt proxies to it. Stdlib HTTP, like xtts_server.py.

    ~/.venvs/stt/bin/python voicelab/stt_server.py        # port 8791

Endpoints
    GET  /health                   -> {ok, model, device, compute_type, load_seconds}
    POST /transcribe?lang=cs       <- audio (WAV from the page; anything ffmpeg/PyAV reads)
                                   -> {text, language, seconds, audio_seconds}

On the CPU by default: kaceybody's 2 GB GPU belongs to XTTS. `small` is the
smallest model that is decent at Czech; set STT_MODEL=base for speed, or
medium for accuracy if the machine can afford it.
"""

from __future__ import annotations

import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

PORT = int(os.environ.get("STT_PORT", "8791"))
HOST = os.environ.get("STT_HOST", "127.0.0.1")          # no auth: loopback only
MODEL = os.environ.get("STT_MODEL", "small")
DEVICE = os.environ.get("STT_DEVICE", "cpu")
COMPUTE = os.environ.get("STT_COMPUTE", "int8")
THREADS = int(os.environ.get("STT_THREADS", "4"))
MAX_BYTES = 12 * 1024 * 1024                              # ~6 minutes of 16 kHz WAV

_model = None
_lock = threading.Lock()                                  # one transcription at a time
_meta: dict = {}


def load_model() -> None:
    global _model, _meta
    from faster_whisper import WhisperModel

    t0 = time.time()
    print(f"[stt] loading whisper {MODEL} on {DEVICE} ({COMPUTE}) …", flush=True)
    _model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE, cpu_threads=THREADS)
    _meta = {"model": MODEL, "device": DEVICE, "compute_type": COMPUTE,
             "load_seconds": round(time.time() - t0, 1)}
    print(f"[stt] ready in {_meta['load_seconds']}s", flush=True)


def transcribe(audio: bytes, lang: str | None) -> dict:
    t0 = time.time()
    with _lock:
        segments, info = _model.transcribe(
            io.BytesIO(audio),
            language=lang or None,
            beam_size=1,                 # greedy: a spoken request, not a transcript to publish
            vad_filter=True,             # drop the silence the page recorded around the words
            condition_on_previous_text=False,
        )
        text = " ".join(s.text.strip() for s in segments).strip()
    return {
        "text": text,
        "language": info.language,
        "seconds": round(time.time() - t0, 2),
        "audio_seconds": round(info.duration, 2),
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._json(200, {"ok": _model is not None, **_meta})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/transcribe":
            return self._json(404, {"error": "not found"})
        if _model is None:
            return self._json(503, {"error": "model still loading"})
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BYTES:
            return self._json(400, {"error": "audio missing or too long"})
        audio = self.rfile.read(n)
        lang = (parse_qs(url.query).get("lang") or [""])[0].split("-")[0] or None
        try:
            out = transcribe(audio, lang)
        except Exception as exc:
            print(f"[stt] ERROR: {exc}", flush=True)
            return self._json(500, {"error": str(exc)})
        print(f"[stt] {out['audio_seconds']}s audio -> {len(out['text'])}ch in {out['seconds']}s", flush=True)
        return self._json(200, out)


def main() -> int:
    load_model()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[stt] listening on http://{HOST}:{PORT}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
