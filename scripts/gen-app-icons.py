#!/usr/bin/env python3
"""Regenerate Lanka app-icon (Android) + web-logo/favicon assets from a square
source PNG. Re-run whenever the logo changes.

    python3 scripts/gen-app-icons.py [source.png]   # default: public/logo.png

Writes:
  public/logo.png, public/favicon.ico
  android/app/src/main/res/mipmap-<density>/ic_launcher.png + ic_launcher_round.png
  android/app/src/main/res/mipmap-<density>/ic_launcher_foreground.png  (adaptive)
Prints the sampled background colour for android values/colors.xml.
"""
import os
import sys
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, "android/app/src/main/res")
PUB = os.path.join(ROOT, "public")

src_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(PUB, "logo.png")
src = Image.open(src_path).convert("RGBA")
if src.width != src.height:
    print(f"warning: source is {src.size}, not square", file=sys.stderr)

# Launcher background = the logo's own backdrop (sampled from a corner).
bg = src.getpixel((4, 4))
bg_hex = "#%02X%02X%02X" % bg[:3]

LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
FOREGROUND = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}


def round_crop(img):
    s = img.size[0]
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, s, s), fill=255)
    out = img.copy()
    out.putalpha(mask)
    return out


for name, sz in LEGACY.items():
    d = os.path.join(RES, f"mipmap-{name}")
    os.makedirs(d, exist_ok=True)
    icon = src.resize((sz, sz), Image.LANCZOS)
    icon.save(os.path.join(d, "ic_launcher.png"))
    round_crop(icon).save(os.path.join(d, "ic_launcher_round.png"))

# Adaptive foreground: scale the source into the central ~72% safe zone of the
# 108dp canvas so the system mask never clips the mark; the adaptive background
# colour fills the rest.
for name, sz in FOREGROUND.items():
    d = os.path.join(RES, f"mipmap-{name}")
    os.makedirs(d, exist_ok=True)
    canvas = Image.new("RGBA", (sz, sz), (0, 0, 0, 0))
    inner = int(round(sz * 0.72))
    off = (sz - inner) // 2
    canvas.alpha_composite(src.resize((inner, inner), Image.LANCZOS), (off, off))
    canvas.save(os.path.join(d, "ic_launcher_foreground.png"))

os.makedirs(PUB, exist_ok=True)
src.resize((512, 512), Image.LANCZOS).save(os.path.join(PUB, "logo.png"))
src.save(os.path.join(PUB, "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])

print(f"icon background colour: {bg_hex}")
print("done")
