import asyncio
import json
from pathlib import Path

import edge_tts


ROOT = Path(__file__).resolve().parents[1]
CUES = json.loads((ROOT / "data" / "cues.json").read_text(encoding="utf-8"))
OUTPUT = ROOT / "public" / "audio" / "voice"
VOICE = "pt-BR-FranciscaNeural"


async def generate() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for cue in CUES:
        target = OUTPUT / f"cue-{cue['id']}.mp3"
        communicate = edge_tts.Communicate(
            cue["text"],
            VOICE,
            rate="+25%",
            pitch="-2Hz",
            volume="+0%",
        )
        await communicate.save(str(target))
        if target.stat().st_size == 0:
            raise RuntimeError(f"Narração vazia: {target}")
        print(f"{cue['id']} -> {target.name} ({target.stat().st_size} bytes)")


if __name__ == "__main__":
    asyncio.run(generate())
