"""Runs the real tts.serve() loop with fake engines, so the app can be tested
without any speech models. Each fake clip is a short tone."""
import math
import struct
import subprocess
import sys
import time
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tts"))
import tts  # noqa: E402


def fake_engine(text, out_path, voice, device):
    if text.startswith("FAIL"):
        raise RuntimeError("boom")
    if text.startswith("NEEDS-DOWNLOAD"):
        sys.exit("Piper voice x is not downloaded yet. Run it once with --allow-download.")
    if text.startswith("DIE"):
        import os
        os._exit(3)
    time.sleep(0.12 if not text.startswith("SLOW") else 0.6)
    print("engine chatter that must stay out of the protocol")
    subprocess.run(["echo", "child process output on stdout"])
    with wave.open(out_path, "wb") as clip:
        clip.setnchannels(1)
        clip.setsampwidth(2)
        clip.setframerate(16000)
        count = 16000 // 4  # 0.25 s
        clip.writeframes(b"".join(struct.pack("<h", int(6000 * math.sin(i / 7))) for i in range(count)))


for name in tts.ENGINES:
    tts.SYNTHS[name] = fake_engine

tts.main()  # handles --serve and --voices-json exactly like the real script
