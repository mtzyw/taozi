#!/usr/bin/env python3
"""Generate simple transparent PNG tabbar icons without external dependencies."""
from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

OUT_DIR = Path('miniprogram/assets/tabbar')
SIZE = 81
AA = 4
CANVAS = SIZE * AA
NORMAL = (155, 120, 112, 255)  # #9b7870
ACTIVE = (229, 72, 98, 255)    # #e54862


def write_png(path: Path, pixels: list[tuple[int, int, int, int]], size: int = SIZE) -> None:
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            raw.extend(pixels[y * size + x])

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    path.write_bytes(png)


class IconCanvas:
    def __init__(self, color: tuple[int, int, int, int]):
        self.color = color
        self.pixels = [(0, 0, 0, 0)] * (CANVAS * CANVAS)

    def _to_px(self, value: float) -> float:
        return value / 100 * CANVAS

    def _blend(self, x: int, y: int, color: tuple[int, int, int, int] | None = None) -> None:
        if x < 0 or y < 0 or x >= CANVAS or y >= CANVAS:
            return
        src = color or self.color
        idx = y * CANVAS + x
        dst = self.pixels[idx]
        sa = src[3] / 255
        da = dst[3] / 255
        out_a = sa + da * (1 - sa)
        if out_a <= 0:
            self.pixels[idx] = (0, 0, 0, 0)
            return
        out = tuple(round((src[i] * sa + dst[i] * da * (1 - sa)) / out_a) for i in range(3))
        self.pixels[idx] = (*out, round(out_a * 255))

    def circle(self, cx: float, cy: float, r: float) -> None:
        cx, cy, r = self._to_px(cx), self._to_px(cy), self._to_px(r)
        x0, x1 = int(cx - r - 1), int(cx + r + 1)
        y0, y1 = int(cy - r - 1), int(cy + r + 1)
        rr = r * r
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                if (x - cx) ** 2 + (y - cy) ** 2 <= rr:
                    self._blend(x, y)

    def ring(self, cx: float, cy: float, r: float, width: float) -> None:
        cx, cy, r, width = self._to_px(cx), self._to_px(cy), self._to_px(r), self._to_px(width)
        inner = max(0, r - width)
        x0, x1 = int(cx - r - 1), int(cx + r + 1)
        y0, y1 = int(cy - r - 1), int(cy + r + 1)
        rr, ii = r * r, inner * inner
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                d = (x - cx) ** 2 + (y - cy) ** 2
                if ii <= d <= rr:
                    self._blend(x, y)

    def line(self, x1: float, y1: float, x2: float, y2: float, width: float) -> None:
        x1, y1, x2, y2, width = map(self._to_px, (x1, y1, x2, y2, width))
        half = width / 2
        minx, maxx = int(min(x1, x2) - half - 1), int(max(x1, x2) + half + 1)
        miny, maxy = int(min(y1, y2) - half - 1), int(max(y1, y2) + half + 1)
        dx, dy = x2 - x1, y2 - y1
        length2 = dx * dx + dy * dy or 1
        for y in range(miny, maxy + 1):
            for x in range(minx, maxx + 1):
                t = max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / length2))
                px, py = x1 + t * dx, y1 + t * dy
                if (x - px) ** 2 + (y - py) ** 2 <= half * half:
                    self._blend(x, y)
        self.circle(x1 / CANVAS * 100, y1 / CANVAS * 100, half / CANVAS * 100)
        self.circle(x2 / CANVAS * 100, y2 / CANVAS * 100, half / CANVAS * 100)

    def polyline(self, points: list[tuple[float, float]], width: float) -> None:
        for a, b in zip(points, points[1:]):
            self.line(a[0], a[1], b[0], b[1], width)

    def polygon(self, points: list[tuple[float, float]]) -> None:
        pts = [(self._to_px(x), self._to_px(y)) for x, y in points]
        miny, maxy = int(min(y for _, y in pts)), int(max(y for _, y in pts))
        for y in range(miny, maxy + 1):
            intersections = []
            for i, (x1, y1) in enumerate(pts):
                x2, y2 = pts[(i + 1) % len(pts)]
                if (y1 <= y < y2) or (y2 <= y < y1):
                    x = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
                    intersections.append(x)
            intersections.sort()
            for a, b in zip(intersections[0::2], intersections[1::2]):
                for x in range(int(a), int(b) + 1):
                    self._blend(x, y)

    def downsample(self) -> list[tuple[int, int, int, int]]:
        out: list[tuple[int, int, int, int]] = []
        for y in range(SIZE):
            for x in range(SIZE):
                acc = [0, 0, 0, 0]
                for yy in range(AA):
                    for xx in range(AA):
                        p = self.pixels[(y * AA + yy) * CANVAS + (x * AA + xx)]
                        for i in range(4):
                            acc[i] += p[i]
                out.append(tuple(round(v / (AA * AA)) for v in acc))
        return out


def rounded_rect(c: IconCanvas, x: float, y: float, w: float, h: float, radius: float, stroke: float) -> None:
    # Approximate rounded rectangle with thick lines and corner circles.
    c.line(x + radius, y, x + w - radius, y, stroke)
    c.line(x + radius, y + h, x + w - radius, y + h, stroke)
    c.line(x, y + radius, x, y + h - radius, stroke)
    c.line(x + w, y + radius, x + w, y + h - radius, stroke)
    c.ring(x + radius, y + radius, radius, stroke)
    c.ring(x + w - radius, y + radius, radius, stroke)
    c.ring(x + radius, y + h - radius, radius, stroke)
    c.ring(x + w - radius, y + h - radius, radius, stroke)


def draw_home(color):
    c = IconCanvas(color)
    c.polyline([(21, 49), (50, 24), (79, 49)], 8)
    c.line(31, 47, 31, 78, 7)
    c.line(69, 47, 69, 78, 7)
    c.line(31, 78, 69, 78, 7)
    c.line(50, 79, 50, 62, 7)
    return c.downsample()


def draw_products(color):
    c = IconCanvas(color)
    c.ring(50, 58, 25, 8)
    c.line(50, 34, 44, 23, 6)
    c.polygon([(52, 30), (71, 19), (76, 35), (61, 40)])
    c.line(58, 33, 71, 24, 3)
    return c.downsample()


def draw_orders(color):
    c = IconCanvas(color)
    rounded_rect(c, 26, 18, 48, 62, 6, 7)
    c.line(37, 36, 64, 36, 6)
    c.line(37, 50, 64, 50, 6)
    c.line(37, 64, 55, 64, 6)
    c.line(26, 78, 34, 71, 5)
    c.line(74, 78, 66, 71, 5)
    return c.downsample()


def draw_profile(color):
    c = IconCanvas(color)
    c.ring(50, 34, 15, 7)
    c.polyline([(26, 78), (31, 66), (42, 58), (50, 57), (58, 58), (69, 66), (74, 78)], 8)
    c.line(34, 78, 66, 78, 8)
    return c.downsample()


ICONS = {
    'home': draw_home,
    'products': draw_products,
    'orders': draw_orders,
    'profile': draw_profile,
}

OUT_DIR.mkdir(parents=True, exist_ok=True)
for name, draw in ICONS.items():
    write_png(OUT_DIR / f'{name}.png', draw(NORMAL))
    write_png(OUT_DIR / f'{name}-active.png', draw(ACTIVE))
    print(f'generated {name}.png and {name}-active.png')
