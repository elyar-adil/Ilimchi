"""从 design/animal-sprite.webp（4x3 个 128px 图块）切出各尺寸 PNG 图标。
用法: python3 -I design/make-app-icons.py public/icons design/animal-sprite.webp
"""
import sys
from PIL import Image, ImageDraw, ImageChops
out = sys.argv[1]
sp = Image.open(sys.argv[2]).convert('RGB')
for i in range(12):
    cx, cy = (i % 4) * 128, (i // 4) * 128
    tile = sp.crop((cx, cy, cx + 128, cy + 128))
    sq = tile.crop((2, 2, 126, 126))  # 去掉精灵图边缘的奶油色渗色
    for size in (512, 192, 180, 96):
        im = sq.resize((size, size), Image.LANCZOS).convert('RGBA')
        k = 4
        m = Image.new('L', (size * k, size * k), 0)
        ImageDraw.Draw(m).rounded_rectangle((0, 0, size * k - 1, size * k - 1), radius=int(size * k * 0.225), fill=255)
        im.putalpha(m.resize((size, size), Image.LANCZOS))
        im.save(f'{out}/animal-{i+1:02d}-{size}.png', optimize=True)
