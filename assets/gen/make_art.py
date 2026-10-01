#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一乘 · 抽刀断水 — 本仓全部位图资产的唯一产地。

母题（和玩法一一对应，不是随手画的装饰）：
  * 4×4 的纸色数字格 —— 盘面就是 hitori 的方格，格子上的圆点是「打点」这一状态。
  * 被涂黑的格子 —— 规则 2 的墨水，黑格永不相邻，所以母题里黑格彼此隔着纸格。
  * 一道从左上到右下的刀光 —— 「抽刀断水」：刀光切过的地方水面荡开涟漪，
    涟漪用规则 3 的青色（连通），刀光用 focus 的青蓝，黑格用 --shade。
  * 涟漪与纸纹同时被复用成游戏内贴图：同一套视觉语言，盘内盘外不分家。

配色不凭空编：全部取自 css/game.css 与 js/view.js 里那份实测 token（两处必须一致，
playtest 的 @pointer/@motion 会核对），这里只是把它们画成位图。

重跑（确定性，无随机种子之外的输入）：
    python3 assets/gen/make_art.py
产物：icons/*.png（16…1024 + maskable + apple-touch）、assets/img/*.png（贴图、社交卡）。
"""
import os
import random

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
ICONS = os.path.join(ROOT, 'icons')
IMGS = os.path.join(ROOT, 'assets', 'img')

# css/game.css :root 的那批 token，一字不改地搬过来。
INK = (232, 230, 225)
BG = (20, 22, 26)
BG2 = (27, 30, 36)
TILE = (220, 215, 202)
TILE2 = (199, 193, 178)
SHADE = (16, 18, 22)
DOT = (123, 132, 148)
RULE1 = (215, 105, 95)
RULE2 = (169, 139, 216)
RULE3 = (95, 188, 207)
FOCUS = (134, 199, 224)
WIN = (87, 201, 138)
PICK = (224, 182, 74)

ICON_SIZES = [16, 32, 48, 96, 192, 512, 1024]
APPLE_SIZE = 180
MASTER = 1024

# 一乘的黑格：4×4 里涂 4 格，任意两格不正交相邻（这就是规则 2 成立的一个真盘面）。
SHADED_CELLS = {(0, 2), (1, 0), (2, 3), (3, 1)}
DOTTED_CELLS = {(1, 2), (2, 1)}
# 一乘的数字：每行每列的未涂格互不相等（规则 1 成立）。
DIGITS = [
    [3, 1, 4, 2],
    [1, 4, 2, 3],
    [4, 2, 3, 1],
    [2, 3, 1, 4],
]


def mix(a, b, t):
    return tuple(int(a[i] * (1 - t) + b[i] * t) for i in range(3))


def with_a(c, a):
    return (c[0], c[1], c[2], a)


def shade(c, f):
    return tuple(int(max(0, min(255, v * f))) for v in c)


def vertical_gradient(size, top, bottom):
    img = Image.new('RGB', (size, size), top)
    d = ImageDraw.Draw(img)
    for y in range(size):
        d.line([(0, y), (size, y)], fill=mix(top, bottom, y / max(1, size - 1)))
    return img


def grain(size, amount, seed, tint=(0, 0, 0)):
    """细颗粒：确定性种子，重跑逐字节相同。"""
    rnd = random.Random(seed)
    layer = Image.new('L', (size, size), 0)
    px = layer.load()
    for y in range(size):
        for x in range(size):
            px[x, y] = int(rnd.random() * amount)
    out = Image.new('RGBA', (size, size), with_a(tint, 0))
    out.putalpha(layer)
    return out


def water_background(size):
    """深水底：径向渐变 + 几道被刀光荡开的涟漪弧。"""
    img = vertical_gradient(size, mix(BG, BG2, 0.35), SHADE[:3]).convert('RGBA')
    d = ImageDraw.Draw(img, 'RGBA')
    cx, cy = size * 0.5, size * 0.62
    for k in range(9):
        r = size * (0.16 + 0.085 * k)
        alpha = int(46 - k * 4.2)
        if alpha <= 0:
            continue
        col = with_a(RULE3 if k % 2 == 0 else FOCUS, alpha)
        d.arc([cx - r, cy - r * 0.62, cx + r, cy + r * 0.62],
              start=200, end=340, fill=col, width=max(2, int(size * 0.011)))
    glow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([size * 0.18, size * 0.02, size * 0.86, size * 0.66], fill=with_a(mix(BG2, FOCUS, 0.18), 90))
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.09))
    img = Image.alpha_composite(img, glow)
    return img


def rounded_cell(d, box, radius, fill, outline=None, width=0):
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def blade(img, size, x0, y0, x1, y1):
    """刀光：一条带高光的斜劈，画在盘面之上——「断水」发生在盘面上。"""
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for width_frac, colour in [
        (0.055, with_a(mix(FOCUS, RULE3, 0.5), 46)),
        (0.028, with_a(FOCUS, 96)),
        (0.010, with_a(INK, 235)),
    ]:
        d.line([(x0, y0), (x1, y1)], fill=colour, width=max(2, int(size * width_frac)))
    # 刃口两侧的溅水：三个大小递减的水点，落点确定，不靠随机。
    for t, rad in [(0.18, 0.021), (0.52, 0.030), (0.83, 0.017)]:
        bx = x0 + (x1 - x0) * t
        by = y0 + (y1 - y0) * t
        d.ellipse([bx - size * rad, by - size * rad * 0.7,
                   bx + size * rad, by + size * rad * 0.7], fill=with_a(FOCUS, 120))
    layer = layer.filter(ImageFilter.GaussianBlur(size * 0.0035))
    return Image.alpha_composite(img, layer)


def board_icon(size, padded=False):
    """母图标：深水上的一块 4×4 纸盘 + 黑格 + 打点 + 一道刀光。

    padded=True 走 maskable 的安全区（内容缩到 80%，四边留够可被系统裁掉的余量）。
    """
    img = water_background(size)
    u = size / 100.0
    inset = 12.0 if not padded else 22.0
    span = 100.0 - 2 * inset
    n = 4
    gap = span * 0.035
    cell = (span - gap * (n - 1)) / n
    x0, y0 = inset, inset + (100 - 2 * inset - (cell * n + gap * (n - 1))) / 2.0
    # 单位空间（0…100）→ 像素：一次换算，后面全部用像素，别再混着画。
    bx0, by0 = x0 * u, y0 * u
    bx1 = (x0 + cell * n + gap * (n - 1)) * u
    by1 = (y0 + cell * n + gap * (n - 1)) * u
    # 盘面垫一块更深的桌布，让纸格在深水上仍然读得出边界
    d = ImageDraw.Draw(img, 'RGBA')
    pad = gap * 1.4 * u
    rounded_cell(d, [bx0 - pad, by0 - pad, bx1 + pad, by1 + pad], 5.5 * u,
                 with_a(mix(SHADE, BG, 0.35), 232), with_a(mix(BG2, FOCUS, 0.35), 200),
                 max(2, int(0.9 * u)))

    tiles = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    td = ImageDraw.Draw(tiles)
    font = load_font(int(cell * u * 0.52))
    for r in range(n):
        for c in range(n):
            x = x0 + c * (cell + gap)
            y = y0 + r * (cell + gap)
            box = [x * u, y * u, (x + cell) * u, (y + cell) * u]
            if (r, c) in SHADED_CELLS:
                rounded_cell(td, box, 2.2 * u, with_a(SHADE, 255))
                td.rounded_rectangle([b + 1 for b in box], radius=2.2 * u,
                                     outline=with_a(mix(SHADE, INK, 0.22), 120), width=max(1, int(0.4 * u)))
                digit_colour = with_a(mix(SHADE, DOT, 0.55), 200)
            else:
                paper = mix(TILE, TILE2, 0.35)
                rounded_cell(td, box, 2.2 * u, with_a(paper, 255))
                digit_colour = with_a(mix(SHADE, INK, 0.12), 235)
            if font is not None:
                s = str(DIGITS[r][c])
                bb = td.textbbox((0, 0), s, font=font)
                tw, th = bb[2] - bb[0], bb[3] - bb[1]
                td.text(((box[0] + box[2]) / 2 - tw / 2 - bb[0], (box[1] + box[3]) / 2 - th / 2 - bb[1]),
                        s, font=font, fill=digit_colour)
            if (r, c) in DOTTED_CELLS:
                cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
                rr = cell * u * 0.34
                td.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=with_a(DOT, 235),
                           width=max(2, int(0.8 * u)))
    img = Image.alpha_composite(img, tiles)
    # 纸纹压在纸格上：alpha 很轻（10%），只落在未涂格，不抢数字。
    paper_tex = tile_texture(max(64, size // 4)).resize((size, size), Image.BILINEAR)
    mask = Image.new('L', (size, size), 0)
    md = ImageDraw.Draw(mask)
    for r in range(n):
        for c in range(n):
            if (r, c) in SHADED_CELLS:
                continue
            x = x0 + c * (cell + gap)
            y = y0 + r * (cell + gap)
            md.rounded_rectangle([x * u, y * u, (x + cell) * u, (y + cell) * u], radius=2.2 * u, fill=255)
    alpha = Image.composite(paper_tex.split()[3], Image.new('L', (size, size), 0), mask)
    paper_tex = paper_tex.copy()
    paper_tex.putalpha(alpha.point(lambda v: int(v * 0.10)))
    img = Image.alpha_composite(img, paper_tex)
    over = pad * 2.2
    img = blade(img, size, bx0 - over, by1 + over * 0.5, bx1 + over, by0 - over * 0.5)
    return img


def load_font(px, cjk=False):
    """按需要挑一张脸：数字用 mono，中文标题必须用带 CJK 的脸。

    挑不到 CJK 字体时返回 None，调用方**换成纯拉丁文案**而不是画出豆腐块——
    一张满是 □ 的社交卡比没有卡更糟。
    """
    from PIL import ImageFont
    names = (['/System/Library/Fonts/PingFang.ttc',
              '/System/Library/Fonts/Hiragino Sans GB.ttc',
              '/System/Library/Fonts/Supplemental/Songti.ttc',
              '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
              '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc']
             if cjk else
             ['/System/Library/Fonts/SFMono-Regular.otf',
              '/System/Library/Fonts/Menlo.ttc',
              '/System/Library/Fonts/Helvetica.ttc',
              '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'])
    for path in names:
        if not os.path.exists(path):
            continue
        for index in range(4):
            try:
                f = ImageFont.truetype(path, px, index=index)
            except OSError:
                continue
            if not cjk or _draws_cjk(f):
                return f
    return None


def _draws_cjk(font):
    """这一张脸真的画得出中文吗（而不是回落到 .notdef 的方框）。

    判据是形状而不是 bbox 相等：「一」是一根又宽又扁的横，「口」接近正方；
    缺字时的方框会和「口」一样高，所以只认「一」明显比「口」扁。
    """
    try:
        a = font.getmask('一').getbbox()
        b = font.getmask('口').getbbox()
    except Exception:
        return False
    if not a or not b:
        return False
    wa, ha = a[2] - a[0], a[3] - a[1]
    hb = b[3] - b[1]
    return hb > 0 and wa > 0 and ha < hb * 0.45 and wa > ha * 3


def write(img, rel, expected=None, min_bytes=1024):
    path = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    out = img.convert('RGBA') if img.mode != 'RGBA' else img
    out.save(path, 'PNG', optimize=True)
    size = os.path.getsize(path)
    assert size > min_bytes, f'{rel} 只有 {size} 字节，不像真图'
    assert expected is None or out.size == expected, f'{rel} 尺寸 {out.size} 与期望 {expected} 不符'
    print(f'{rel:38s} {out.size[0]}x{out.size[1]}  {size}B')
    return path


# ---------------------------------------------------------------- 游戏内贴图

def tile_texture(size, strength=255):
    """纸纹：横向纤维 + 细颗粒，用在未涂格上（canvas 里当 pattern 叠一层）。"""
    base = Image.new('RGBA', (size, size), with_a(TILE, 0))
    d = ImageDraw.Draw(base, 'RGBA')
    rnd = random.Random(7)
    for k in range(size // 3):
        y = rnd.randrange(size)
        ln = size * (0.25 + rnd.random() * 0.7)
        x = rnd.randrange(-size // 2, size)
        a = int(rnd.random() * 16)
        d.line([(x, y), (x + ln, y + rnd.randrange(-2, 3))], fill=with_a(mix(TILE, SHADE, 0.5), a),
               width=max(1, size // 128))
    base = Image.alpha_composite(base, grain(size, 34, 11))
    return base


def ink_texture(size):
    """墨纹：涂黑格上的笔触，斜向刷痕 + 颗粒，让黑格不是一块死色。"""
    base = Image.new('RGBA', (size, size), with_a(SHADE, 0))
    d = ImageDraw.Draw(base, 'RGBA')
    rnd = random.Random(3)
    for k in range(size // 5):
        off = rnd.randrange(-size, size)
        a = int(rnd.random() * 26)
        d.line([(off, 0), (off + size * 0.5, size)], fill=with_a(mix(SHADE, FOCUS, 0.35), a),
               width=max(2, size // 40))
    return Image.alpha_composite(base, grain(size, 26, 21, tint=(60, 70, 90)))


def table_texture(size):
    """桌布：棋盘底那块深色面，带极淡的经纬。"""
    base = Image.new('RGBA', (size, size), with_a(mix(BG, SHADE, 0.5), 255))
    d = ImageDraw.Draw(base, 'RGBA')
    step = max(4, size // 24)
    for i in range(0, size, step):
        d.line([(i, 0), (i, size)], fill=with_a(BG2, 26), width=1)
        d.line([(0, i), (size, i)], fill=with_a(BG2, 18), width=1)
    return Image.alpha_composite(base, grain(size, 18, 31))


def ripple_sprite(size):
    """涟漪精灵：一圈水纹 + 一圈高光，赢棋时从最后一格荡开（reduced-motion 下画静帧）。"""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, 'RGBA')
    cx = cy = size / 2
    for k, (frac, col, wfrac) in enumerate([
        (0.46, with_a(RULE3, 150), 0.030),
        (0.36, with_a(FOCUS, 110), 0.018),
        (0.24, with_a(INK, 70), 0.010),
    ]):
        r = size * frac
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=col, width=max(2, int(size * wfrac)))
    return img.filter(ImageFilter.GaussianBlur(size * 0.008))


def _tokens(text):
    """拉丁按词、汉字按字折行——两种文案共用一套排版。"""
    import re
    cjk = '\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\u2018\u2019\u201c\u201d'
    return re.findall(r'\s+|[' + cjk + r']|[^' + cjk + r'\s]+', text)


def wrap_lines(f, text, max_w):
    lines = []
    cur = ''
    for tok in _tokens(text):
        cand = cur + tok
        if cur and (f.getbbox(cand)[2] - f.getbbox(cand)[0]) > max_w:
            lines.append(cur.rstrip())
            cur = tok.lstrip()
        else:
            cur = cand
    if cur.strip():
        lines.append(cur.rstrip())
    return lines


def shared_font(texts, max_w, px, cjk=False, min_px=11):
    """一组同级别的行要用**同一个字号**：各自缩到放得下，会让最短的那行长得最大。"""
    size = px
    f = load_font(size, cjk=cjk)
    while f and size > min_px and any(f.getbbox(t)[2] - f.getbbox(t)[0] > max_w for t in texts):
        size = int(size * 0.9)
        f = load_font(size, cjk=cjk)
    return f


def draw_block(d, x, y, text, max_w, px, fill, cjk=False, leading=1.28, font=None):
    """画一段文字（放不下就折行），返回占用高度。font 用于跨行统一字号。"""
    f = font if font is not None else shared_font([text], max_w, px, cjk=cjk)
    if f is None:
        return 0
    line_h = int(f.size * leading)
    lines = wrap_lines(f, text, max_w)
    for k, line in enumerate(lines):
        d.text((x, y + k * line_h), line, font=f, fill=fill)
    return line_h * len(lines)


def og_cover():
    """社交卡 1200×630：盘面缩在左边，右边是名字与三条规则。

    文案按列宽折行，任何一行都越不过右边界；挑不到中文字体就整段换成拉丁文案，
    因为一张满是 □ 的卡比没有卡更糟。
    """
    W, H = 1200, 630
    img = Image.new('RGBA', (W, H), with_a(mix(BG, SHADE, 0.45), 255))
    d = ImageDraw.Draw(img, 'RGBA')
    for k in range(7):
        r = H * (0.5 + 0.16 * k)
        d.arc([W * 0.28 - r, H * 0.55 - r * 0.55, W * 0.28 + r, H * 0.55 + r * 0.55],
              start=200, end=340, fill=with_a(RULE3 if k % 2 == 0 else FOCUS, 40 - k * 4), width=5)
    side = 470
    img.alpha_composite(board_icon(512), (int(W * 0.28 - side / 2), int(H / 2 - side / 2)))
    x = 700
    col = W - x - 56
    cjk = load_font(96, cjk=True) is not None
    if cjk:
        rows = [('一乘', 104, INK),
                ('抽刀断水 · HITORI', 46, FOCUS),
                ('规则 1  每行每列不许留下两个相等的未涂数字', 34, mix(INK, BG2, 0.2)),
                ('规则 2  涂黑的格子不得正交相邻', 34, mix(INK, BG2, 0.2)),
                ('规则 3  未涂的格子必须连成一片', 34, mix(INK, BG2, 0.2)),
                ('40 盘 · 每一盘的解数由两套独立代码逐格复核 · 难度是量出来的', 26, DOT)]
    else:
        rows = [('YI CHENG', 96, INK),
                ('HITORI · CUT THE WATER', 44, FOCUS),
                ('RULE 1  no two open digits alike in a row or column', 34, mix(INK, BG2, 0.2)),
                ('RULE 2  no two shaded cells touch', 34, mix(INK, BG2, 0.2)),
                ('RULE 3  every open cell stays connected', 34, mix(INK, BG2, 0.2)),
                ('40 boards · each solution cross-checked by two independent solvers', 26, DOT)]
    rule_font = shared_font([r[0] for r in rows[2:5]], col, 34, cjk=cjk)
    y = 108
    for k, (text, px, colour) in enumerate(rows):
        h = draw_block(d, x, y, text, col, px, with_a(colour, 255), cjk=cjk,
                       font=rule_font if 2 <= k <= 4 else None)
        y += h + (34 if k == 1 else 0) + (26 if k >= 2 else 0)
    d.rectangle([0, 0, W - 1, H - 1], outline=with_a(mix(BG2, FOCUS, 0.4), 200), width=3)
    return img


def main():
    master = board_icon(MASTER)
    write(master, os.path.join('icons', 'icon-1024.png'))
    for s in ICON_SIZES:
        if s == MASTER:
            continue
        write(master.resize((s, s), Image.LANCZOS), os.path.join('icons', f'icon-{s}.png'),
              expected=(s, s), min_bytes=600 if s >= 48 else 250)
    write(master.resize((APPLE_SIZE, APPLE_SIZE), Image.LANCZOS), os.path.join('icons', 'apple-touch-icon.png'))
    write(board_icon(512, padded=True), os.path.join('icons', 'icon-maskable-512.png'))
    write(og_cover(), os.path.join('assets', 'img', 'og-cover.png'), expected=(1200, 630))
    write(tile_texture(128), os.path.join('assets', 'img', 'tile-paper.png'))
    write(ink_texture(128), os.path.join('assets', 'img', 'tile-ink.png'))
    write(table_texture(256), os.path.join('assets', 'img', 'board-table.png'))
    write(ripple_sprite(256), os.path.join('assets', 'img', 'ripple.png'))
    write(master.resize((256, 256), Image.LANCZOS), os.path.join('assets', 'img', 'board-mark.png'))


if __name__ == '__main__':
    os.chdir(ROOT)
    main()
