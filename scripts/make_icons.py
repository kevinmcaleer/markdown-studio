"""Draw the PWA icons (web/public/icons) from the logo's shapes.

Run with any Python that has Pillow: python scripts/make_icons.py
The logo is the "M↓" mark from web/public/favicon.svg on each app's colour.
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "web" / "public" / "icons"
COLOURS = {"studio": "#262624", "notes": "#c96442", "tables": "#3f7d6e", "decks": "#6a5acd"}
# The favicon's two paths, in its 64x64 coordinate space.
M = [
    (14, 44),
    (14, 20),
    (20, 20),
    (26, 29),
    (32, 20),
    (38, 20),
    (38, 44),
    (32, 44),
    (32, 30),
    (26, 39),
    (20, 30),
    (20, 44),
]
ARROW = [(44, 44), (37, 35), (41.5, 35), (41.5, 20), (46.5, 20), (46.5, 35), (51, 35)]
SCALE = 4  # draw big, then shrink, for smooth edges


def icon(colour: str, size: int, maskable: bool) -> Image.Image:
    big = size * SCALE
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    if maskable:
        # Full bleed; the mark sits in the middle 60% safe zone.
        draw.rectangle((0, 0, big, big), fill=colour)
        mark, offset = big * 0.6 / 64, big * 0.2
    else:
        draw.rounded_rectangle((0, 0, big - 1, big - 1), radius=big * 14 / 64, fill=colour)
        mark, offset = big / 64, 0
    for shape in (M, ARROW):
        draw.polygon([(offset + x * mark, offset + y * mark) for x, y in shape], fill="white")
    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, colour in COLOURS.items():
        for size in (192, 512):
            icon(colour, size, False).save(OUT / f"{name}-{size}.png", optimize=True)
        icon(colour, 512, True).save(OUT / f"{name}-maskable-512.png", optimize=True)
        icon(colour, 180, True).convert("RGB").save(OUT / f"{name}-apple-180.png", optimize=True)


if __name__ == "__main__":
    main()
