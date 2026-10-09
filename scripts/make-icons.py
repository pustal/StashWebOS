"""Generates the webOS launcher icons and splash screen in assets/icons/.

Run from the project root:  python3 scripts/make-icons.py
Needs Pillow.

Source: assets/icons/source/stash-logo.jpg, the Stash project's logo
(https://avatars.githubusercontent.com/u/24867479?s=400&v=4, 400x400 on
black). It belongs to the Stash project; check their terms before
publishing builds that use it.
"""
from pathlib import Path

from PIL import Image

SOURCE = Path("assets/icons/source/stash-logo.jpg")
OUT = Path("assets/icons")
BG = (0, 0, 0)  # the logo's own background, so edges blend in


def icon(size):
    """The logo scaled to a square launcher icon."""
    return Image.open(SOURCE).convert("RGB").resize((size, size), Image.LANCZOS)


def splash():
    """Full-screen splash: the logo centred on its own black background."""
    im = Image.new("RGB", (1920, 1080), BG)
    logo = icon(400)
    im.paste(logo, ((1920 - 400) // 2, (1080 - 400) // 2))
    return im


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    icon(80).save(OUT / "icon.png", optimize=True)
    icon(130).save(OUT / "largeIcon.png", optimize=True)
    splash().save(OUT / "splash.png", optimize=True)
    print("icons written to", OUT)
