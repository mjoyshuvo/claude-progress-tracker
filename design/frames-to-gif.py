# Joins the PNG frames that design/demo-gif.mjs writes into one looping GIF.
#
#   python3 design/frames-to-gif.py <frames dir> <out.gif>
#
# The frames dir holds 0000.png, 0001.png, ... and durations.json (milliseconds per frame).

import json
import sys
from pathlib import Path

from PIL import Image

frames_dir, out = Path(sys.argv[1]), Path(sys.argv[2])
durations = json.loads((frames_dir / "durations.json").read_text())
paths = sorted(frames_dir.glob("*.png"))

# One palette for every frame, taken from frames across the whole run, so colours do not
# shift between frames.
sample = [Image.open(p).convert("RGB") for p in paths[:: max(1, len(paths) // 8)]]
strip = Image.new("RGB", (sample[0].width, sample[0].height * len(sample)))
for i, frame in enumerate(sample):
    strip.paste(frame, (0, i * frame.height))
palette = strip.quantize(colors=128, method=Image.Quantize.MEDIANCUT)

frames = [Image.open(p).convert("RGB").quantize(palette=palette, dither=Image.Dither.NONE) for p in paths]
frames[0].save(out, save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=True, disposal=1)
print(f"{out}: {len(frames)} frames, {out.stat().st_size // 1024} KB")
