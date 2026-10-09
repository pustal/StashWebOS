"""Generates the webOS launcher icons and splash screen in assets/icons/.

Run from the project root:  python3 scripts/make-icons.py
Needs Pillow. Uses the bundled Bricolage Grotesque font when FreeType can
read WOFF2, otherwise falls back to DejaVu Sans Bold.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BG = (29, 21, 38)       # --bg
BRASS = (232, 185, 96)  # --brass
INK = (43, 29, 7)       # --brass-ink
TEXT = (244, 237, 228)  # --text
OUT = Path("assets/icons")
FONT = Path("node_modules/@fontsource/bricolage-grotesque/files/bricolage-grotesque-latin-700-normal.woff2")


def font(size):
    """Bricolage if readable, else a common bold sans."""
    for candidate in (str(FONT), "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def icon(size):
    """Brass disc with an 'S' on the stage colour, drawn 4x and downsampled."""
    s = size * 4
    im = Image.new("RGBA", (s, s), BG + (255,))
    d = ImageDraw.Draw(im)
    pad = int(s * 0.1)
    d.ellipse([pad, pad, s - pad, s - pad], fill=BRASS)
    d.text((s / 2, s / 2 + s * 0.02), "S", font=font(int(s * 0.55)), fill=INK, anchor="mm")
    return im.resize((size, size), Image.LANCZOS)


def splash():
    """Full-screen splash: the mark and the word on the stage colour."""
    im = Image.new("RGB", (1920, 1080), BG)
    mark = icon(160)
    im.paste(mark, (760 - 80, 460), mark)
    d = ImageDraw.Draw(im)
    d.text((880, 540), "Stash", font=font(120), fill=TEXT, anchor="lm")
    return im


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    icon(80).save(OUT / "icon.png")
    icon(130).save(OUT / "largeIcon.png")
    splash().save(OUT / "splash.png", optimize=True)
    print("icons written to", OUT)
