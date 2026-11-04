p = r'C:\Users\admin\Desktop\逆向工程\paperlite\src\renderer\src\reflow.ts'
s = open(p, encoding='utf-8').read()

old = "    if (absorbed > 0) blocks.splice(i + 1, absorbed)\n  }\n}"
new = (
    "    if (absorbed > 0) blocks.splice(i + 1, absorbed)\n"
    "  }\n"
    "  // 兜底：吸收后公式块内仍含孤立单字母词串（跨栏碎片残余），移除\n"
    "  for (const b of blocks) {\n"
    "    if (b.kind !== 'formula') continue\n"
    "    const cleaned = b.text.replace(/(?:\\b[a-z]\\b\\s*){2,}/gi, '')\n"
    "    b.text = cleaned.replace(/\\s+/g, ' ').trim()\n"
    "  }\n"
    "}"
)
assert old in s, 'tail not found'
s = s.replace(old, new)
open(p, 'w', encoding='utf-8').write(s)
print('cleanup pass in')
