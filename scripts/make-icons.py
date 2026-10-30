"""Erzeugt die PNG-Icons (192, 512, maskable 512) im selben Motiv wie icons/icon.svg."""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'icons')
BRAND, WHITE, FOLD, GREY = '#0f5c5c', '#ffffff', '#a8d5d1', '#9bb8b6'

def draw(size, maskable):
    s = size / 512
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, size, size], fill=BRAND)  # volle Fläche, Android schneidet selbst zu
        k, off = 0.74, size * 0.13  # Motiv in der Sicherheitszone (innere 80 %)
    else:
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=96 * s, fill=BRAND)
        k, off = 1.0, 0.0
    def P(x, y):
        return (off + x * s * k, off + y * s * k)
    def box(x0, y0, x1, y1):
        return [*P(x0, y0), *P(x1, y1)]
    d.polygon([P(148, 96), P(308, 96), P(384, 172), P(384, 416), P(364, 436), P(148, 436), P(128, 416), P(128, 116)], fill=WHITE)
    d.polygon([P(308, 96), P(308, 152), P(328, 172), P(384, 172)], fill=FOLD)
    for (y, w, col, h) in [(216, 172, BRAND, 18), (262, 172, GREY, 18), (308, 110, GREY, 18), (364, 172, BRAND, 26)]:
        d.rounded_rectangle(box(170, y, 170 + w, y + h), radius=h * s * k / 2, fill=col)
    return img

for name, size, mk in [('icon-192.png', 192, False), ('icon-512.png', 512, False), ('icon-maskable-512.png', 512, True)]:
    draw(size, mk).save(os.path.join(OUT, name))
    print('geschrieben', name)
