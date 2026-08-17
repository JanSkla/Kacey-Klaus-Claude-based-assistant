"""Measure what actually makes XTTS faster on this CPU.

Four levers, benchmarked rather than guessed:
  1. thread count            — torch.set_num_threads()
  2. text length             — is cost linear, or is there fixed overhead?
  3. streaming inference     — time to FIRST audio chunk (what a listener feels)
  4. int8 dynamic quantisation — smaller/faster Linear layers on CPU

Run:  .venv-xtts/Scripts/python.exe voicelab/xtts_bench.py
"""

from __future__ import annotations

import os
import time

os.environ.setdefault("COQUI_TOS_AGREED", "1")

import torch

SPEAKER = "Ana Florence"
SHORT = "Poznamenáno."
MED = "Zítra v deset máte schůzku s panem Petrem."
LONG = (
    "Zítra v deset máte schůzku s panem Petrem, a vzhledem k tomu, že si neplánujete "
    "nic před devátou, nedoporučovala bych pozdní návrat."
)


def bench(fn, runs=1):
    best = None
    for _ in range(runs):
        t = time.time()
        fn()
        d = time.time() - t
        best = d if best is None else min(best, d)
    return best


def main() -> int:
    from TTS.api import TTS

    print("loading model…", flush=True)
    t0 = time.time()
    tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2", progress_bar=False)
    print(f"loaded in {time.time() - t0:.1f}s\n", flush=True)

    model = tts.synthesizer.tts_model
    gpt_cond_latent, speaker_embedding = model.speaker_manager.speakers[SPEAKER].values()

    def synth(text):
        return model.inference(
            text, "cs", gpt_cond_latent, speaker_embedding, enable_text_splitting=False
        )

    # ---- 1. thread count -------------------------------------------------
    print("== threads (medium sentence) ==", flush=True)
    for n in (4, 8, 12, 16):
        torch.set_num_threads(n)
        d = bench(lambda: synth(MED))
        print(f"  {n:2d} threads : {d:6.2f}s", flush=True)

    torch.set_num_threads(16)

    # ---- 2. does length dominate, or is there fixed cost? ----------------
    print("\n== text length (16 threads) ==", flush=True)
    for label, text in (("short", SHORT), ("medium", MED), ("long", LONG)):
        d = bench(lambda: synth(text))
        rate = len(text) / d
        print(f"  {label:6} {len(text):3d} chars : {d:6.2f}s  ({rate:5.1f} chars/s)", flush=True)

    # ---- 3. streaming: time to FIRST chunk -------------------------------
    print("\n== streaming (time to first audio) ==", flush=True)
    for label, text in (("medium", MED), ("long", LONG)):
        t = time.time()
        first = None
        chunks = 0
        for _ in model.inference_stream(
            text, "cs", gpt_cond_latent, speaker_embedding, enable_text_splitting=False
        ):
            chunks += 1
            if first is None:
                first = time.time() - t
        total = time.time() - t
        print(
            f"  {label:6}: first chunk {first:5.2f}s | total {total:5.2f}s | {chunks} chunks",
            flush=True,
        )

    # ---- 4. int8 dynamic quantisation ------------------------------------
    print("\n== int8 dynamic quantisation ==", flush=True)
    try:
        before = bench(lambda: synth(MED))
        qmodel = torch.quantization.quantize_dynamic(
            model, {torch.nn.Linear}, dtype=torch.qint8
        )

        def qsynth():
            return qmodel.inference(
                MED, "cs", gpt_cond_latent, speaker_embedding, enable_text_splitting=False
            )

        after = bench(qsynth)
        print(f"  fp32 : {before:6.2f}s", flush=True)
        print(f"  int8 : {after:6.2f}s  ({before / after:.2f}x)", flush=True)
        print("  NOTE: check the audio still sounds right — quantisation can hurt quality.",
              flush=True)
    except Exception as exc:
        print(f"  quantisation failed: {exc}", flush=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
