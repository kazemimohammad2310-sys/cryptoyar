#!/usr/bin/env python3
"""Generate CryptoYar PWA icons (candlestick motif on dark navy)."""
from PIL import Image, ImageDraw
import os

OUT = "/home/z/my-project/public/pwa"
os.makedirs(OUT, exist_ok=True)

BG = (13, 18, 32, 255)        # #0d1220 dark navy (matches dashboard)
GREEN = (34, 197, 94, 255)    # #22c55e
RED = (239, 68, 68, 255)      # #ef4444
GOLD = (245, 185, 62, 255)    # #f5b93e (dashboard accent)


def rounded_bg(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(size * 0.22)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=BG)
    return img


def draw_candle(d: ImageDraw.Draw, cx, body_top, body_bot, wick_top, wick_bot,
                 width, color):
    # wick
    d.line([(cx, wick_top), (cx, wick_bot)], fill=color, width=max(2, width // 4))
    # body
    d.rounded_rectangle([cx - width // 2, body_top, cx + width // 2, body_bot],
                        radius=max(2, width // 6), fill=color)


def make_icon(size: int) -> Image.Image:
    img = rounded_bg(size)
    d = ImageDraw.Draw(img)
    s = size

    # candlestick chart: low green, lower red, higher green (rising)
    cw = int(s * 0.11)  # candle width
    candles = [
        # (cx, wick_top, body_top, body_bot, wick_bot, color)
        (s * 0.30, s * 0.28, s * 0.42, s * 0.72, s * 0.80, GREEN),
        (s * 0.50, s * 0.36, s * 0.52, s * 0.76, s * 0.86, RED),
        (s * 0.70, s * 0.14, s * 0.24, s * 0.58, s * 0.66, GREEN),
    ]
    for cx, wt, bt, bb, wb, col in candles:
        draw_candle(d, cx, bt, bb, wt, wb, cw, col)

    # rising gold trend line with arrow head
    pts = [(s * 0.18, s * 0.62), (s * 0.40, s * 0.52), (s * 0.60, s * 0.40), (s * 0.82, s * 0.20)]
    d.line(pts, fill=GOLD, width=max(4, int(s * 0.035)), joint="curve")
    # arrow head at the end
    ax, ay = pts[-1]
    ah = s * 0.09
    d.polygon([(ax + ah * 0.9, ay - ah * 0.15), (ax - ah * 0.45, ay - ah * 0.85),
               (ax - ah * 0.10, ay + ah * 0.75)], fill=GOLD)
    return img


# 512 master
icon512 = make_icon(512)
icon512.save(f"{OUT}/icon-512.png")

# 192
make_icon(192).save(f"{OUT}/icon-192.png")

# apple-touch 180 — solid background (no transparency for iOS)
apple = Image.new("RGB", (180, 180), BG[:3])
a = make_icon(180)
apple.paste(a, (0, 0), a)
apple.save(f"{OUT}/apple-touch-icon.png")

# favicon 64
make_icon(64).save(f"{OUT}/favicon-64.png")

for f in sorted(os.listdir(OUT)):
    p = os.path.join(OUT, f)
    print(f, os.path.getsize(p), "bytes")
print("ICONS DONE")
