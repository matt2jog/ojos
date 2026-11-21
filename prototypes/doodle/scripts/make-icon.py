"""Draws the Ojos app icon (dark rounded square, two eyes, Google-colored j nose, spark).
Pure Python so it needs no image libraries. Usage: python3 scripts/make-icon.py resources/icon.png [size]"""
import math, struct, sys, zlib

OUT = sys.argv[1]
SIZE = int(sys.argv[2]) if len(sys.argv) > 2 else 512
SS = 3
BG, WHITE, DARK = (23, 24, 28), (255, 255, 255), (24, 25, 28)
STOPS = [(0.0, (66, 133, 244)), (0.35, (52, 168, 83)), (0.7, (251, 188, 5)), (1.0, (234, 67, 53))]

def grad(t):
    t = min(1, max(0, t))
    for (a, ca), (b, cb) in zip(STOPS, STOPS[1:]):
        if t <= b:
            k = (t - a) / (b - a)
            return tuple(ca[i] + (cb[i] - ca[i]) * k for i in range(3))
    return STOPS[-1][1]

def in_round_rect(x, y, lo, hi, r):
    cx = min(max(x, lo + r), hi - r); cy = min(max(y, lo + r), hi - r)
    return math.hypot(x - cx, y - cy) <= r and lo <= x <= hi and lo <= y <= hi

def color(x, y):  # design units 0..100; returns rgb or None (transparent)
    if not in_round_rect(x, y, 5, 95, 22):
        return None
    c = BG
    for ex in (30.5, 69.5):
        if math.hypot(x - ex, y - 53) <= 15.5: c = WHITE
        if math.hypot(x - (ex + 2.2), y - 54) <= 7.6: c = DARK
        if math.hypot(x - (ex - 0.6), y - 51) <= 2.4: c = WHITE
    # j nose: stem, hook curling left, round tip
    if abs(x - 50) <= 2.3 and 44 <= y <= 61: c = grad((y - 44) / 24)
    if math.hypot(x - 50, y - 44) <= 2.3: c = grad(0)
    r = math.hypot(x - 45.2, y - 61)
    if y >= 61 and 2.5 <= r <= 7.1: c = grad((y - 44) / 24)
    if math.hypot(x - 40.4, y - 62.2) <= 3.9: c = STOPS[-1][1]
    # spark above the nose (four-point star)
    dx, dy = abs(x - 50), abs(y - 33.5)
    if math.sqrt(dx) + math.sqrt(dy) <= math.sqrt(7.2): c = WHITE
    return c

rows = []
u = 100.0 / (SIZE * SS)
for py in range(SIZE):
    row = bytearray([0])
    for px in range(SIZE):
        acc = [0.0, 0.0, 0.0]; n = 0
        for j in range(SS):
            for i in range(SS):
                c = color((px * SS + i + 0.5) * u, (py * SS + j + 0.5) * u)
                if c: acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; n += 1
        if n: row += bytes([round(acc[0] / n), round(acc[1] / n), round(acc[2] / n), round(255 * n / (SS * SS))])
        else: row += b'\x00\x00\x00\x00'
    rows.append(bytes(row))
def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
open(OUT, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b''))
