"""Makes every app, extension and download-page icon from the otter drawing.

    python3 design/icon/make_icons.py

The otter is cut out of otter-drawing.jpg, its blue-grey wash lifted to near-white, and the paper around
it is tinted, so the grain carries on behind it. Change BACKGROUND or the framings below and run it again.
Needs Pillow, and npm dependencies installed (it runs `tauri icon` for the desktop sizes).
"""

import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DESKTOP_ICONS = ROOT / "apps/desktop/src-tauri/icons"
EXTENSION_ICONS = ROOT / "apps/extension/public/icon"
SITE = ROOT / "site"

BACKGROUND = "#16191F"  # ink: blue-black like the eyes and nose, so the white otter stands out even at 16 px
WHITE_OTTER = True  # False keeps the wash blue-grey, as painted
GRAIN = 0.7  # paper grain in the background; full strength looks gritty on a dark colour
EDGE = 3  # how much the outline is tidied, in drawing pixels: grain-sized nicks go, the brush line stays

# Squares in drawing pixels. The composition is the drawing's: the otter close to the right side, its body
# cut at the left and bottom, open space at the top left. FULL keeps the right and bottom edges measured from
# the first drawing's pencil frame (the redraw is the same painting at twice the size). Its size sets how big
# the otter is: 920 leaves a little room above the head.
FULL = (201, 118, 1121, 1038)
FACE = (479, 165, 1121, 807)  # head only, for the 16 and 32 px toolbar icons

src = Image.open(HERE / "otter-drawing.jpg").convert("RGB")
PAPER_MEAN = 240  # the blank paper's grey level


def otter_mask():
    lum = src.convert("L")
    m = lum.point(lambda v: 255 if v < 224 else 0)
    # Opening removes stray specks on the paper; closing fills light specks inside the paint.
    m = m.filter(ImageFilter.MinFilter(9)).filter(ImageFilter.MaxFilter(9))
    m = m.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.MinFilter(9))
    # Closing also bridges notches in the outline, such as where an ear meets the head: keep bare paper out.
    m = ImageChops.darker(m, lum.point(lambda v: 255 if v < 234 else 0))
    # Blur and re-threshold: nicks the size of the paper grain go, the brush's line stays.
    m = m.filter(ImageFilter.GaussianBlur(EDGE)).point(lambda v: 255 if v >= 128 else 0)
    m = m.filter(ImageFilter.MinFilter(5))  # two pixels in, so no white paper rim shows
    return m.filter(ImageFilter.GaussianBlur(2.4))


MASK = otter_mask()
# Where the paper isn't bare: under the otter and the soft edge of the paint just around it.
NEAR_OTTER = MASK.point(lambda v: 255 if v else 0).filter(ImageFilter.MaxFilter(17)).filter(ImageFilter.GaussianBlur(4))


def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


INK = (34, 40, 46)  # the eyes, nose and lines


def whiten(img, lift=0.42, tint=0.3, ink=INK):
    """The wash (grey ~150-207) becomes near-white with its shading kept; the ink lines (~30-110) stay dark."""
    lum = img.convert("L")
    soft = lum.filter(ImageFilter.GaussianBlur(1.4))  # the ink edge follows the stroke, not the paper grain
    out = []
    for (r, g, b), l, ls in zip(img.getdata(), lum.getdata(), soft.getdata()):
        body = 255 - (255 - l) * lift
        # A little of the painted colour stays, so it still reads as watercolour.
        wash = (body + (r - l) * tint, body + (g - l) * tint, body + (b - l) * tint)
        k = smoothstep(125, 50, ls)  # 0 on the wash, 1 on the ink
        out.append(tuple(round(max(0, min(255, c * (1 - k) + i * k))) for c, i in zip(wash, ink)))
    res = Image.new("RGB", img.size)
    res.putdata(out)
    return res


OTTER = src.copy()
if WHITE_OTTER:
    OTTER.paste(whiten(src.crop(FULL)), FULL[:2])  # FACE sits inside FULL


def tinted_paper(color, box):
    # The sheet's own paper, tinted, so the grain lines up with the otter's. It goes flat near the otter,
    # where paint would show through as a halo.
    lum = src.crop(box).convert("L")
    paper = Image.composite(Image.new("L", lum.size, PAPER_MEAN), lum, NEAR_OTTER.crop(box))
    return Image.merge("RGB", [
        paper.point(lambda v, c=c: max(0, min(255, round(c + (v - PAPER_MEAN) * GRAIN))))
        for c in color
    ])


def scene(box):
    return Image.composite(OTTER.crop(box), tinted_paper(hex_rgb(BACKGROUND), box), MASK.crop(box))


def hex_rgb(value):
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def rounded(size, radius, ss=4):
    m = Image.new("L", (size * ss, size * ss), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size * ss - 1, size * ss - 1), radius * ss, fill=255)
    return m.resize((size, size), Image.LANCZOS)


def mac_icon(size=1024):
    """Apple's macOS grid: an 824/1024 rounded square, centred, with a soft shadow."""
    body = round(size * 824 / 1024)
    inset = (size - body) // 2
    shape = rounded(body, body * 0.2237)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow = Image.new("L", (size, size), 0)
    shadow.paste(shape, (inset, inset + round(size * 10 / 1024)))
    shadow = shadow.filter(ImageFilter.GaussianBlur(size * 14 / 1024)).point(lambda v: round(v * 0.3))
    canvas.paste((0, 0, 0, 255), (0, 0, size, size), shadow)
    tile = scene(FULL).resize((body, body), Image.LANCZOS).convert("RGBA")
    tile.putalpha(shape)
    canvas.alpha_composite(tile, (inset, inset))
    return canvas


def tile_icon(size, box, pad=0):
    """A rounded tile with `pad` transparent pixels around it, for Chrome."""
    body = size - 2 * pad
    tile = scene(box).resize((body, body), Image.LANCZOS).convert("RGBA")
    tile.putalpha(rounded(body, body * 0.2))
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(tile, (pad, pad))
    return canvas


def main():
    master = HERE / "app-icon.png"
    mac_icon().save(master)

    # `tauri icon` also makes Android and iOS sets: keep only the files the desktop app already has.
    with tempfile.TemporaryDirectory() as out:
        subprocess.run(["npx", "tauri", "icon", str(master), "-o", out], cwd=ROOT, check=True)
        for existing in DESKTOP_ICONS.iterdir():
            made = Path(out) / existing.name
            if made.is_file():
                shutil.copyfile(made, existing)

    # Toolbar sizes show just the head. The 128 px one follows Chrome's guideline: 96 px of art in 16 px of padding.
    tile_icon(16, FACE).save(EXTENSION_ICONS / "16.png")
    tile_icon(32, FACE).save(EXTENSION_ICONS / "32.png")
    tile_icon(48, FULL, pad=2).save(EXTENSION_ICONS / "48.png")
    tile_icon(128, FULL, pad=16).save(EXTENSION_ICONS / "128.png")

    # The download page: the Mac icon at twice the size it is shown, and the toolbar head as the tab icon.
    mac_icon(512).save(SITE / "icon.png", optimize=True)
    tile_icon(32, FACE).save(SITE / "favicon.png")


if __name__ == "__main__":
    main()
