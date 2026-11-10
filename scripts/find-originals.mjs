/** 全盘找三篇论文原件：按首屏文本匹配（PDF 内容流多为压缩，grep 不可靠） */
import fs from 'node:fs'
import path from 'node:path'
import m from 'mupdf'

const ROOTS = (process.argv[2] ?? 'C:/Users/admin').split(';')
const NEEDLES = [
  ['trainable', /trainable\s+pseudo-?label/i],
  ['multiscale', /multiscale\s+residual\s+active/i],
  ['comparative', /comparative\s+study\s+of\s+machine\s+learning\s+and\s+deep/i]
]

const files = []
function walk(dir, depth) {
  if (depth > 9) return
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (/node_modules|\$Recycle|Windows|Program Files|AppData\/Local\/Temp\/.*\.zip/i.test(p)) continue
      walk(p, depth + 1)
    } else if (/\.pdf$/i.test(e.name)) {
      try {
        const st = fs.statSync(p)
        if (st.size > 300_000) files.push({ p, size: st.size })
      } catch { /* skip */ }
    }
  }
}
for (const r of ROOTS) walk(r, 0)
console.log('candidate pdfs:', files.length)

const hits = []
for (const f of files) {
  let doc
  try {
    doc = m.Document.openDocument(new Uint8Array(fs.readFileSync(f.p)), 'application/pdf')
    const n = Math.min(2, doc.countPages())
    let text = ''
    for (let i = 0; i < n; i++) text += doc.loadPage(i).toStructuredText().asJSON()
    for (const [tag, re] of NEEDLES) {
      if (re.test(text)) {
        hits.push({ tag, path: f.p, size: f.size })
        console.log('HIT', tag, f.p, f.size)
      }
    }
  } catch { /* 非 PDF/损坏，跳过 */ } finally { try { doc?.destroy() } catch { /* ignore */ } }
}
console.log('hits:', hits.length)
