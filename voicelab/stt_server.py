"""Persistent Whisper speech-to-text server for Kacey.

The bedside kiosk runs Epiphany (WebKitGTK), which has no working Web Speech
recognition — so the page records the utterance itself and sends it here.
faster-whisper (CTranslate2) holds the model in memory and answers over plain
HTTP; Kacey's /api/stt proxies to it. Stdlib HTTP, like xtts_server.py.

    ~/.venvs/stt/bin/python voicelab/stt_server.py        # port 8791

Endpoints
    GET  /health                   -> {ok, model, choice, loading, device, compute_type, load_seconds}
    POST /transcribe?lang=cs       <- audio (WAV from the page; anything ffmpeg/PyAV reads)
                                   -> {text, language, seconds, audio_seconds, model}
    POST /model?name=turbo         -> 202 {choice, loading}: load the other model

Whisper large v3 by default — the best of the family at Czech. Its turbo
variant (large-v3-turbo: the same encoder, 4 decoder layers instead of 32) is
several times faster at a small cost in accuracy; the page switches between the
two and the choice is kept across restarts (stt_state.json beside this file).
Turbo needs faster-whisper >= 1.1.

On the CPU by default: kaceybody's 2 GB GPU belongs to XTTS. Only one model is
held at a time — the old one is dropped before the new one loads, so a switch
never needs the RAM of both.
"""

from __future__ import annotations

import gc
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
DEVICE = os.environ.get("STT_DEVICE", "cpu")
COMPUTE = os.environ.get("STT_COMPUTE", "int8")
THREADS = int(os.environ.get("STT_THREADS", "4"))
MAX_BYTES = 12 * 1024 * 1024                              # ~6 minutes of 16 kHz WAV

# The page's two choices -> faster-whisper's model names.
CHOICES = {"large-v3": "large-v3", "turbo": "large-v3-turbo"}
STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stt_state.json")

_model = None
_lock = threading.Lock()                                  # one transcription (or swap) at a time
_meta: dict = {}
_choice = "large-v3"
_loading = False
_error = ""


def saved_choice() -> str:
    """The page's last choice, else STT_MODEL, else large v3."""
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            name = json.load(f).get("model")
        if name in CHOICES:
            return name
    except (OSError, ValueError):
        pass
    env = os.environ.get("STT_MODEL", "large-v3")
    return env if env in CHOICES else "large-v3"


def load_model(choice: str) -> None:
    """Drop the model held now and load `choice` in its place."""
    global _model, _meta, _choice, _loading, _error
    from faster_whisper import WhisperModel

    _choice, _loading, _error = choice, True, ""
    name = CHOICES[choice]
    try:
        with _lock:
            _model = None                                 # free its RAM before the next one loads
            gc.collect()
            t0 = time.time()
            print(f"[stt] loading whisper {name} on {DEVICE} ({COMPUTE}) …", flush=True)
            _model = WhisperModel(name, device=DEVICE, compute_type=COMPUTE, cpu_threads=THREADS)
            _meta = {"model": choice, "device": DEVICE, "compute_type": COMPUTE,
                     "load_seconds": round(time.time() - t0, 1)}
        print(f"[stt] ready in {_meta['load_seconds']}s", flush=True)
        try:
            with open(STATE_FILE, "w", encoding="utf-8") as f:
                json.dump({"model": choice}, f)
        except OSError as exc:
            print(f"[stt] could not keep the choice: {exc}", flush=True)
    except Exception as exc:                              # e.g. turbo on a faster-whisper < 1.1
        _error = str(exc)
        print(f"[stt] ERROR loading {name}: {exc}", flush=True)
    finally:
        _loading = False


def switch(choice: str) -> None:
    """Load `choice`; when it will not load, go back to large v3 so dictation still works."""
    load_model(choice)
    if _model is None and choice != "large-v3":
        failed = _error
        load_model("large-v3")
        globals()["_error"] = f"{choice}: {failed}"


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
        "model": _meta.get("model"),
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
            return self._json(200, {"ok": _model is not None and not _loading, **_meta,
                                    "choice": _choice, "loading": _loading, "error": _error,
                                    "choices": list(CHOICES)})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        global _loading, _choice, _error
        url = urlparse(self.path)
        if url.path == "/model":
            name = (parse_qs(url.query).get("name") or [""])[0]
            if name not in CHOICES:
                return self._json(400, {"error": f"unknown model {name!r}"})
            if _loading:
                return self._json(409, {"error": "a model is loading", "choice": _choice})
            if name != _meta.get("model") or _model is None:
                _loading, _choice = True, name            # before the reply, so /health agrees at once
                threading.Thread(target=switch, args=(name,), daemon=True).start()
            else:
                # Already held (e.g. back to large v3 after turbo failed): the old error is moot.
                _error, _choice = "", name
                try:
                    with open(STATE_FILE, "w", encoding="utf-8") as f:
                        json.dump({"model": name}, f)
                except OSError:
                    pass
            return self._json(202, {"choice": name, "loading": _loading})
        if url.path != "/transcribe":
            return self._json(404, {"error": "not found"})
        if _model is None or _loading:
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
    # Listen first and load behind it: /health answers "loading" rather than
    # nothing during the minute large v3 takes to come up.
    threading.Thread(target=switch, args=(saved_choice(),), daemon=True).start()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[stt] listening on http://{HOST}:{PORT}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
