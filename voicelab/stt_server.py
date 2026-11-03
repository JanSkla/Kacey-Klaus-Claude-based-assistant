"""Persistent speech-to-text server for Kacey: Whisper or Parakeet.

The bedside kiosk runs Epiphany (WebKitGTK), which has no working Web Speech
recognition — so the page records the utterance itself and sends it here.
faster-whisper (CTranslate2) or onnx-asr (ONNX Runtime) holds the model in
memory and answers over plain HTTP; Kacey's /api/stt proxies to it. Stdlib
HTTP, like xtts_server.py.

    ~/.venvs/stt/bin/python voicelab/stt_server.py        # port 8791

Endpoints
    GET  /health                   -> {ok, model, choice, loading, device, compute_type, load_seconds}
    POST /transcribe?lang=cs       <- audio (WAV from the page; anything ffmpeg/PyAV reads)
                                   -> {text, language, seconds, audio_seconds, model}
                                   &partial=1: the words so far, while the owner speaks
                                   (Parakeet only, via Kacey) — answered alike, not logged
    POST /model?name=turbo         -> 202 {choice, loading}: load another model

Whisper small by default: on kaceybody's 4-core CPU it writes a sentence down
in about 5 s. Large v3 is the best of the family at Czech and its turbo
variant (large-v3-turbo: the same encoder, 4 decoder layers instead of 32)
nearly as good, but both run the large encoder over a 30 s window for every
utterance — there that was 27–37 s a sentence, however short. Parakeet TDT
0.6B v3 (NVIDIA, 25 European languages, int8 ONNX via onnx-asr) is not a
Whisper: its time follows the audio, ~0.2x real time there, so a short
command takes under a second, and on real Czech speech it made about half
small's word errors (timed 2026-11-01). It cannot be told the language: now
and then it writes a sentence as Slovak or Polish. The page switches between
the four and the choice is kept across restarts (stt_state.json beside this
file). Turbo needs faster-whisper >= 1.1, Parakeet onnx-asr[hub].

On the CPU by default: kaceybody's 2 GB GPU belongs to XTTS. Only one model is
held at a time — the old one is dropped before the new one loads, so a switch
never needs the RAM of both. Dropped means handed back to the system too:
glibc keeps a freed model's arenas otherwise, and on kaceybody a switch from
large v3 to turbo left the sidecar at 5.1 GB with swap full.
"""

from __future__ import annotations

import ctypes
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

# The page's choices -> (engine, the engine's model name).
CHOICES = {
    "small": ("whisper", "small"),
    "large-v3": ("whisper", "large-v3"),
    "turbo": ("whisper", "large-v3-turbo"),
    "parakeet": ("parakeet", "nemo-parakeet-tdt-0.6b-v3"),
}
RATE = 16000
# Parakeet attends over the whole utterance at once (memory grows with its
# square), so anything longer goes in pieces of this many seconds.
PARAKEET_CHUNK_S = 30
DEFAULT = "small"
STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stt_state.json")

_model = None
_lock = threading.Lock()                                  # one transcription (or swap) at a time
_meta: dict = {}
_choice = DEFAULT
_loading = False
_error = ""


def saved_choice() -> str:
    """The page's last choice, else STT_MODEL, else small."""
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            name = json.load(f).get("model")
        if name in CHOICES:
            return name
    except (OSError, ValueError):
        pass
    env = os.environ.get("STT_MODEL", DEFAULT)
    return env if env in CHOICES else DEFAULT


def release() -> None:
    """Give a dropped model's memory back to the system, not just to malloc."""
    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except (OSError, AttributeError):                     # not glibc: nothing to trim
        pass


def open_model(engine: str, name: str):
    """The model itself, and the device and precision it runs at."""
    if engine == "parakeet":
        import onnx_asr
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = THREADS
        # Always the CPU and int8: the GPU is XTTS's, and the float model is 2.5 GB.
        return onnx_asr.load_model(name, quantization="int8", sess_options=opts), "cpu", "int8"
    from faster_whisper import WhisperModel

    return WhisperModel(name, device=DEVICE, compute_type=COMPUTE, cpu_threads=THREADS), DEVICE, COMPUTE


def load_model(choice: str) -> None:
    """Drop the model held now and load `choice` in its place."""
    global _model, _meta, _choice, _loading, _error

    _choice, _loading, _error = choice, True, ""
    engine, name = CHOICES[choice]
    try:
        with _lock:
            _model = None                                 # free its RAM before the next one loads
            release()
            t0 = time.time()
            print(f"[stt] loading {engine} {name} …", flush=True)
            _model, device, compute = open_model(engine, name)
            _meta = {"model": choice, "engine": engine, "device": device, "compute_type": compute,
                     "load_seconds": round(time.time() - t0, 1)}
        print(f"[stt] ready in {_meta['load_seconds']}s", flush=True)
        try:
            with open(STATE_FILE, "w", encoding="utf-8") as f:
                json.dump({"model": choice}, f)
        except OSError as exc:
            print(f"[stt] could not keep the choice: {exc}", flush=True)
    except Exception as exc:                              # e.g. turbo on a faster-whisper < 1.1, no onnx-asr
        _error = str(exc)
        print(f"[stt] ERROR loading {name}: {exc}", flush=True)
    finally:
        _loading = False


def switch(choice: str) -> None:
    """Load `choice`; when it will not load, go back to small so dictation still works."""
    load_model(choice)
    if _model is None and choice != DEFAULT:
        failed = _error
        load_model(DEFAULT)
        globals()["_error"] = f"{choice}: {failed}"


def transcribe(audio: bytes, lang: str | None) -> dict:
    if _meta.get("engine") == "parakeet":
        return transcribe_parakeet(audio, lang)
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


def transcribe_parakeet(audio: bytes, lang: str | None) -> dict:
    """Parakeet takes 16 kHz samples, not a file: PyAV (faster-whisper's) decodes."""
    from faster_whisper.audio import decode_audio

    t0 = time.time()
    samples = decode_audio(io.BytesIO(audio), sampling_rate=RATE)
    step = PARAKEET_CHUNK_S * RATE
    with _lock:
        parts = [_model.recognize(samples[i:i + step], sample_rate=RATE)
                 for i in range(0, max(len(samples), 1), step)]
    return {
        "text": " ".join(p.strip() for p in parts if p and p.strip()),
        "language": lang or "",          # it finds the language itself and does not say which
        "seconds": round(time.time() - t0, 2),
        "audio_seconds": round(len(samples) / RATE, 2),
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
                # Already held (e.g. back to small after turbo failed): the old error is moot.
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
        query = parse_qs(url.query)
        lang = (query.get("lang") or [""])[0].split("-")[0] or None
        try:
            out = transcribe(audio, lang)
        except Exception as exc:
            print(f"[stt] ERROR: {exc}", flush=True)
            return self._json(500, {"error": str(exc)})
        if (query.get("partial") or [""])[0] != "1":         # a partial comes every second or so
            print(f"[stt] {out['audio_seconds']}s audio -> {len(out['text'])}ch in {out['seconds']}s", flush=True)
        return self._json(200, out)


def main() -> int:
    # Listen first and load behind it: /health answers "loading" rather than
    # nothing while the model comes up (about a minute for large v3).
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
