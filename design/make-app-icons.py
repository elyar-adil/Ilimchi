"""从 design/animal-icons.png（4x3 的 12 个图标，奶油色底）切出各尺寸 PNG 图标。
用法: python3 -I design/make-app-icons.py design/animal-icons.png public/icons
依赖: pillow, numpy, scipy
"""
import sys
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGB')
a = np.asarray(im).astype(int)
mask = ndimage.binary_closing(np.abs(a - a[5, 5]).sum(2) > 24, iterations=3)
lab, _ = ndimage.label(mask)
boxes = [(s[0].start, s[1].start, s[0].stop, s[1].stop) for s in ndimage.find_objects(lab) if s[0].stop - s[0].start > 150]
boxes.sort(key=lambda r: (round(r[0] / 200), r[1]))
assert len(boxes) == 12, len(boxes)

for i, (t, l, b, r) in enumerate(boxes):
    s = min(b - t, r - l) - 14  # 向内收 7px，去掉边缘奶油色渗色
    cy, cx = (t + b) // 2, (l + r) // 2
    sq = im.crop((cx - s // 2, cy - s // 2, cx - s // 2 + s, cy - s // 2 + s))
    for size in (512, 192, 180, 96):
        icon = sq.resize((size, size), Image.LANCZOS).convert('RGBA')
        k = 4
        m = Image.new('L', (size * k, size * k), 0)
        ImageDraw.Draw(m).rounded_rectangle((0, 0, size * k - 1, size * k - 1), radius=int(size * k * 0.24), fill=255)
        icon.putalpha(m.resize((size, size), Image.LANCZOS))
        icon.save(f'{out}/animal-{i + 1:02d}-{size}.png', optimize=True)
