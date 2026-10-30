"""Generate fixtures/reflow-test.pdf：3 页、双栏、含页眉页脚/标题/分段/连字符的测试 PDF。

不依赖第三方库，手写 PDF 对象与 xref 表。
"""
import os

W, H = 612, 792
LEFT_X, RIGHT_X = 72, 316
BODY, HEAD = 10, 18
LEAD = 14

def esc(s: str) -> str:
    return s.replace('\\', r'\\').replace('(', r'\(').replace(')', r'\)')

def text_op(x, y, size, s):
    return f"BT /F1 {size} Tf {x} {y} Td ({esc(s)}) Tj ET"

def page_content(lines):
    return "\n".join(text_op(*l) for l in lines).encode('latin-1')

def col_lines(x, y0, texts):
    return [(x, y0 - i * LEAD, BODY, t) for i, t in enumerate(texts)]

p1 = [
    (72, 750, BODY, 'Sample Journal of Testing Vol 42'),
    (72, 700, HEAD, 'A Study of Reflow Engines'),
    *col_lines(LEFT_X, 660, [
        'Reflow engines reconstruct',
        'the reading order of two',
        'column academic papers.',
    ]),
    (LEFT_X, 600, BODY, 'Second paragraph starts here'),
    (LEFT_X, 586, BODY, 'after a clear vertical gap.'),
    *col_lines(RIGHT_X, 660, [
        'Right column line one alpha.',
        'Right column line two beta.',
        'Right column line three ends.',
    ]),
    (280, 40, BODY, 'Page 1'),
]
p2 = [
    (72, 750, BODY, 'Sample Journal of Testing Vol 42'),
    *col_lines(LEFT_X, 660, [
        'Page two left column text',
        'continues the document body',
        'with several more lines.',
        'Fourth line keeps it wide.',
        'Fifth line of the column.',
        'Sixth line ends the block.',
    ]),
    *col_lines(RIGHT_X, 660, [
        'Page two right column text',
        'also continues nicely and',
        'keeps the gutter intact',
        'with enough total lines',
        'for two column detection',
        'to engage as expected.',
    ]),
    (280, 40, BODY, 'Page 2'),
]
p3 = [
    (72, 750, BODY, 'Sample Journal of Testing Vol 42'),
    *col_lines(LEFT_X, 660, [
        'Page three tests the hy-',
        'phenation join behavior',
        'across a broken word.',
        'Another line here.',
        'And one more line.',
        'Final left column line.',
    ]),
    *col_lines(RIGHT_X, 660, [
        'Page three right column',
        'carries simple body text',
        'to balance the layout',
        'and reach the required',
        'line count for the',
        'detection heuristic.',
    ]),
    (280, 40, BODY, 'Page 3'),
]

pages = [p1, p2, p3]
objs = []          # (bytes,) 每个对象的内容（不含 "N 0 obj"/"endobj"）
# 1: Catalog, 2: Pages, 3: Font
catalog = b'<< /Type /Catalog /Pages 2 0 R >>'
pages_obj_placeholder = b''  # 后填
font = b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
objs = [catalog, None, font]
page_ids, content_ids = [], []
for i in range(len(pages)):
    page_ids.append(len(objs) + 1 + i * 2)        # 每页两个对象：Page + Contents
for i, p in enumerate(pages):
    pid = page_ids[i]
    content_ids.append(pid + 1)
    objs.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {W} {H}] '
                f'/Resources << /Font << /F1 3 0 R >> >> /Contents {pid + 1} 0 R >>'.encode())
    data = page_content(p)
    objs.append(b'<< /Length %d >>\nstream\n' % len(data) + data + b'\nendstream')
kids = ' '.join(f'{pid} 0 R' for pid in page_ids)
objs[1] = f'<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>'.encode()

out = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
offsets = [0]
for i, body in enumerate(objs, start=1):
    offsets.append(len(out))
    out += f'{i} 0 obj\n'.encode() + body + b'\nendobj\n'
xref_pos = len(out)
n = len(objs) + 1
out += f'xref\n0 {n}\n'.encode()
out += b'0000000000 65535 f \n'
for off in offsets[1:]:
    out += f'{off:010d} 00000 n \n'.encode()
out += (f'trailer\n<< /Size {n} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n').encode()

dest = os.path.join(os.path.dirname(__file__), 'fixtures')
os.makedirs(dest, exist_ok=True)
path = os.path.join(dest, 'reflow-test.pdf')
with open(path, 'wb') as f:
    f.write(bytes(out))
print('wrote', path, len(out), 'bytes')
