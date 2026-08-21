"""Download XTTS-v2 and audition its built-in Czech-capable speakers.

The CPML licence acceptance below is set on the user's explicit instruction
(they agreed in conversation on 2026-08-03). CPML is NON-COMMERCIAL: fine for a
personal assistant, not for shipping a product.

No voice cloning here — only the studio speakers that ship with the model, whose
audio was recorded with consent. A reference clip of a real person would need
that person's permission.
"""

import os
import sys
import time

os.environ.setdefault("COQUI_TOS_AGREED", "1")

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "samples")
os.makedirs(OUT, exist_ok=True)

# The sentence that actually decides it: 'ř' twice, two names that must decline,
# and Kacey's apologetic register.
SENTENCE = "Odpusťte, nezachytila jsem jméno správně. Řekl jste Řehoř, nebo Jiří?"

def main() -> int:
    from TTS.api import TTS

    print("loading xtts_v2 (first run downloads ~1.8 GB)…", flush=True)
    t0 = time.time()
    tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2", progress_bar=True)
    print(f"model ready in {time.time() - t0:.1f}s", flush=True)

    speakers = list(getattr(tts.synthesizer.tts_model, "speaker_manager").speakers.keys())
    print(f"\nbuilt-in speakers: {len(speakers)}", flush=True)
    for s in speakers:
        print("  ", s, flush=True)

    langs = getattr(tts, "languages", None)
    print(f"\nlanguages: {langs}", flush=True)
    print(f"czech supported: {'cs' in (langs or [])}", flush=True)

    # Audition a handful. Pass names on the command line to override.
    wanted = sys.argv[1:] or speakers[:6]
    print(f"\nsynthesising {len(wanted)} sample(s) to {OUT}\n", flush=True)

    for name in wanted:
        if name not in speakers:
            print(f"  ! unknown speaker: {name}", flush=True)
            continue
        safe = name.replace(" ", "_").replace("/", "_")
        path = os.path.join(OUT, f"xtts_{safe}.wav")
        t = time.time()
        try:
            tts.tts_to_file(
                text=SENTENCE, speaker=name, language="cs", file_path=path,
                split_sentences=True,
            )
            took = time.time() - t
            size = os.path.getsize(path)
            print(f"  {name:26} {took:6.1f}s  {size/1024:7.0f} KB  {path}", flush=True)
        except Exception as exc:  # keep going; one bad speaker should not stop the run
            print(f"  {name:26} FAILED: {exc}", flush=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
