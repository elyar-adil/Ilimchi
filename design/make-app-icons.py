"""从 design/animal-icons.png（4x3 的 12 个图标，奶油色底）切出各尺寸 PNG 图标。
透明蒙版取自图标自身的轮廓（而不是统一圆角矩形），并向内收缩以去掉边缘奶油色渗色。
用法: python3 -I design/make-app-icons.py design/animal-icons.png public/icons
依赖: pillow, numpy, scipy
"""
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

ERODE = 5  # 源图像素；去掉与奶油底混合的边缘
SIZES = (512, 192, 180, 96)

src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGB')
a = np.asarray(im).astype(int)
mask = ndimage.binary_closing(np.abs(a - a[5, 5]).sum(2) > 24, iterations=3)
lab, _ = ndimage.label(mask)
found = [(i + 1, s) for i, s in enumerate(ndimage.find_objects(lab)) if s[0].stop - s[0].start > 150]
found.sort(key=lambda f: (round(f[1][0].start / 200), f[1][1].start))
assert len(found) == 12, len(found)

for n, (label, _) in enumerate(found, 1):
    shape = ndimage.binary_erosion(ndimage.binary_fill_holes(lab == label), iterations=ERODE)
    ys, xs = np.where(shape)
    top, bottom, left, right = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    side = max(bottom - top, right - left)
    cy, cx = (top + bottom) // 2, (left + right) // 2
    box = (cx - side // 2, cy - side // 2, cx - side // 2 + side, cy - side // 2 + side)
    rgb = im.crop(box)
    alpha = Image.fromarray((shape * 255).astype('uint8')).crop(box)
    for size in SIZES:
        k = 3  # 在放大的蒙版上做平滑再缩小，得到抗锯齿边缘
        big = np.asarray(alpha.resize((size * k, size * k), Image.BICUBIC)) > 127
        soft = ndimage.gaussian_filter(big.astype('float32'), k * 0.6) * 255
        icon = rgb.resize((size, size), Image.LANCZOS).convert('RGBA')
        icon.putalpha(Image.fromarray(soft.astype('uint8')).resize((size, size), Image.LANCZOS))
        icon.save(f'{out}/animal-{n:02d}-{size}.png', optimize=True)
