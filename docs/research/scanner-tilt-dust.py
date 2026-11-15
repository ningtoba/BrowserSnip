#!/usr/bin/env python3
"""Read back the two sheets `scanner-tilt-dust.mjs` writes.

  python3 docs/research/scanner-tilt-dust.py angle /tmp/colour/tilt.pdf \
      /tmp/r/scanner-tilt.pdf

  python3 docs/research/scanner-tilt-dust.py dots /tmp/colour/dust.pdf \
      /tmp/r/scanner-dust.pdf

Round 045's two questions, as numbers:

* **angle** — the bar's top edge, fitted by least squares over the columns it
  spans, in degrees. A tool that straightens reports an output angle near zero;
  `scanner-effect` has no geometry stage, so the two numbers and the control
  sheet (an untilted page reads +0.00) are the whole measurement. Sign: negative
  is the edge climbing to the right, the direction `degrees(3)` rotates it.
* **dots** — connected dark components inside the dot grid at the file's own
  density. 40 in, 40 out means nothing removed the dust; a speckle pass would
  answer with fewer, and the size list says which ones went.

Both read the *file*, never a report about it.
"""
import math
import sys

import pymupdf

DPI = 150
DARK = 110


def pixmap(path, page=0, dpi=DPI):
    doc = pymupdf.open(path)
    return doc, doc[page], doc[page].get_pixmap(dpi=dpi, colorspace=pymupdf.csRGB)


def luma(pix, x, y):
    at = (y * pix.width + x) * pix.n
    return (pix.samples[at] * 299 + pix.samples[at + 1] * 587 + pix.samples[at + 2] * 114) // 1000


def angle(path):
    doc, _page, pix = pixmap(path)
    width, height = pix.width, pix.height
    points = []
    for x in range(int(width * 0.15), int(width * 0.8), 2):
        for y in range(int(height * 0.05), int(height * 0.45)):
            if luma(pix, x, y) < DARK:
                points.append((x, y))
                break
    if len(points) < 20:
        doc.close()
        return None, len(points)
    mean_x = sum(x for x, _ in points) / len(points)
    mean_y = sum(y for _, y in points) / len(points)
    slope = sum((x - mean_x) * (y - mean_y) for x, y in points) / sum((x - mean_x) ** 2 for x, _ in points)
    doc.close()
    return math.degrees(math.atan(slope)), len(points)


def components(path):
    """Dark blobs inside the dot grid only — the title band is above it."""
    doc, _page, pix = pixmap(path, dpi=220)
    clip = _page.get_pixmap(dpi=220, clip=pymupdf.Rect(30, 130, 325, 502), colorspace=pymupdf.csRGB)
    width, height, step = clip.width, clip.height, clip.n
    seen = bytearray(width * height)
    sizes = []
    for start in range(width * height):
        if seen[start]:
            continue
        seen[start] = 1
        at = start * step
        if not (clip.samples[at] < 150 or clip.samples[at + 1] < 150):
            continue
        stack = [start]
        size = 0
        while stack:
            current = stack.pop()
            size += 1
            cx, cy = current % width, current // width
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = cx + dx, cy + dy
                if 0 <= nx < width and 0 <= ny < height:
                    neighbour = ny * width + nx
                    if seen[neighbour]:
                        continue
                    seen[neighbour] = 1
                    edge = neighbour * step
                    if clip.samples[edge] < 150 or clip.samples[edge + 1] < 150:
                        stack.append(neighbour)
        sizes.append(size)
    doc.close()
    return sizes


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ('angle', 'dots'):
        print(__doc__)
        return 2
    mode, paths = sys.argv[1], sys.argv[2:]
    for path in paths:
        if mode == 'angle':
            degrees, columns = angle(path)
            print(f'{path}: top-edge angle '
                  f'{"no bar edge found" if degrees is None else f"{degrees:+.2f} deg"} over {columns} columns')
        else:
            sizes = components(path)
            print(f'{path}: {len(sizes)} dark blobs in the dot grid, '
                  f'sizes {sorted(sizes)[:5]}…{sorted(sizes)[-3:]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
