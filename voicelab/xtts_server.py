"""Persistent XTTS-v2 synthesis server for the Voice Lab.

XTTS takes ~10-20 s to load on CPU, so spawning a process per request is hopeless.
This holds the model in memory and answers over plain HTTP; the Node lab proxies
to it. Stdlib only, matching klaus_memory's own style.

    .venv-xtts/Scripts/python.exe voicelab/xtts_server.py        # port 8790

Endpoints
    GET  /health    -> {ok, model, device, languages, speakers:[...]}
    POST /speak     <- {text, speaker, language?, speed?}   -> audio/wav

CPML licence: accepted by the user on 2026-08-03. Non-commercial use only.
Built-in studio speakers only — no cloning of anyone's voice without consent.
"""

from __future__ import annotations

import io
import json
import os
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("COQUI_TOS_AGREED", "1")

PORT = int(os.environ.get("XTTS_PORT", "8790"))
# Loopback by default. Set XTTS_HOST=0.0.0.0 to serve a laptop from a GPU box —
# but there is NO authentication here, so only do that on a network you trust,
# or bind it to a Tailscale address rather than the whole LAN.
HOST = os.environ.get("XTTS_HOST", "127.0.0.1")
MODEL = "tts_models/multilingual/multi-dataset/xtts_v2"

_tts = None
_lock = threading.Lock()          # the model is not safe for concurrent calls
_meta: dict = {}


def load_model() -> None:
    global _tts, _meta
    from TTS.api import TTS

    t0 = time.time()
    print(f"[xtts] loading {MODEL} …", flush=True)
    # Use CUDA when a GPU is present. XTTS is memory-bandwidth bound at batch 1,
    # so a discrete GPU (e.g. RTX 2060, 336 GB/s) is several times a laptop's
    # shared DDR5 (~90 GB/s) — enough to cross from slower-than-realtime to
    # faster, which is what makes streaming playback continuous.
    import torch

    use_gpu = torch.cuda.is_available()
    _tts = TTS(MODEL, progress_bar=False, gpu=use_gpu)
    device = torch.cuda.get_device_name(0) if use_gpu else "cpu"
    print(f"[xtts] device: {device}", flush=True)
    speakers = list(_tts.synthesizer.tts_model.speaker_manager.speakers.keys())
    _meta = {
        "model": MODEL,
        "device": device,
        "sample_rate": _tts.synthesizer.output_sample_rate,
        "languages": list(getattr(_tts, "languages", []) or []),
        "speakers": speakers,
        "load_seconds": round(time.time() - t0, 1),
    }
    print(f"[xtts] ready in {_meta['load_seconds']}s — {len(speakers)} speakers", flush=True)

    # Measured: the FIRST inference costs ~14.5s against ~6s warm. Burn that cost
    # here at startup so the first real request is not the one that pays it.
    try:
        t1 = time.time()
        model = _tts.synthesizer.tts_model
        latent, emb = speaker_latents(speakers[0])
        for _ in model.inference_stream("Dobrý den.", "cs", latent, emb,
                                        enable_text_splitting=False):
            break                                  # first chunk is enough to warm up
        print(f"[xtts] warmed up in {time.time() - t1:.1f}s", flush=True)
    except Exception as exc:
        print(f"[xtts] warmup skipped: {exc}", flush=True)


_latents: dict = {}


def speaker_latents(speaker: str):
    """Conditioning latents per speaker, computed once and reused."""
    if speaker not in _latents:
        entry = _tts.synthesizer.tts_model.speaker_manager.speakers[speaker]
        _latents[speaker] = (entry["gpt_cond_latent"], entry["speaker_embedding"])
    return _latents[speaker]


def pcm16(samples) -> bytes:
    """float [-1,1] -> signed 16-bit little-endian PCM, clipped rather than wrapped."""
    out = bytearray()
    for s in samples:
        v = int(max(-1.0, min(1.0, float(s))) * 32767)
        out += int(v).to_bytes(2, "little", signed=True)
    return bytes(out)


def stream_pcm(text: str, speaker: str, language: str = "cs", speed: float = 1.0):
    """Yield raw PCM chunks as the model produces them.

    Measured: first chunk lands in ~2s regardless of sentence length, versus ~6s
    to wait for a complete sentence. Total wall-clock is slightly worse; nobody
    experiences total wall-clock, they experience the silence before she speaks.
    """
    model = _tts.synthesizer.tts_model
    latent, emb = speaker_latents(speaker)
    with _lock:
        for chunk in model.inference_stream(
            text, language, latent, emb, speed=speed, enable_text_splitting=False
        ):
            yield pcm16(chunk.squeeze().tolist() if hasattr(chunk, "squeeze") else chunk)


def synth_wav(text: str, speaker: str, language: str = "cs", speed: float = 1.0) -> bytes:
    """Synthesise and return a WAV container (the model yields raw float samples)."""
    with _lock:
        wav = _tts.tts(text=text, speaker=speaker, language=language, speed=speed)

    rate = _tts.synthesizer.output_sample_rate
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        # float [-1,1] -> signed 16-bit PCM, clipped rather than wrapped
        frames = bytearray()
        for s in wav:
            v = int(max(-1.0, min(1.0, float(s))) * 32767)
            frames += int(v).to_bytes(2, "little", signed=True)
        w.writeframes(bytes(frames))
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):        # keep stdout for our own lines
        pass

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._json(200, {"ok": _tts is not None, **_meta})
        else:
            self._json(404, {"error": "not found"})

    def _stream(self, text, speaker, language, speed):
        """Chunked raw PCM. The client schedules chunks through Web Audio, so no
        WAV container is involved — a WAV header would need a length we do not
        know yet."""
        t0 = time.time()
        first = None
        total = 0
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("X-Sample-Rate", str(_meta.get("sample_rate", 24000)))
        self.end_headers()
        try:
            for data in stream_pcm(text, speaker, language, speed):
                if first is None:
                    first = time.time() - t0
                total += len(data)
                self.wfile.write(f"{len(data):X}\r\n".encode("ascii"))
                self.wfile.write(data)
                self.wfile.write(b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
            print(
                f"[xtts] stream {speaker} {len(text)}ch -> {total}B "
                f"first={first:.2f}s total={time.time() - t0:.2f}s",
                flush=True,
            )
        except (BrokenPipeError, ConnectionResetError):
            print("[xtts] client disconnected mid-stream", flush=True)

    def do_POST(self):
        if not (self.path.startswith("/speak") or self.path.startswith("/stream")):
            return self._json(404, {"error": "not found"})
        if _tts is None:
            return self._json(503, {"error": "model still loading"})

        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception as exc:
            return self._json(400, {"error": f"bad request: {exc}"})

        text = (req.get("text") or "").strip()
        speaker = req.get("speaker")
        if not text or not speaker:
            return self._json(400, {"error": "text and speaker are required"})

        if self.path.startswith("/stream"):
            return self._stream(
                text, speaker, req.get("language") or "cs", float(req.get("speed") or 1.0)
            )

        try:
            t0 = time.time()
            audio = synth_wav(
                text, speaker,
                language=req.get("language") or "cs",
                speed=float(req.get("speed") or 1.0),
            )
            ms = int((time.time() - t0) * 1000)
            print(f"[xtts] {speaker} {len(text)}ch -> {len(audio)}B in {ms}ms", flush=True)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio)))
            self.send_header("X-Xtts-Ms", str(ms))
            self.end_headers()
            self.wfile.write(audio)
        except Exception as exc:
            print(f"[xtts] ERROR {speaker}: {exc}", flush=True)
            self._json(500, {"error": str(exc)})


def main() -> int:
    load_model()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[xtts] listening on http://{HOST}:{PORT}", flush=True)
    if HOST not in ("127.0.0.1", "localhost"):
        print("[xtts] WARNING: bound beyond loopback with no auth — trusted networks only",
              flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
