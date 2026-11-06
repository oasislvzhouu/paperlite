/** 用 mupdf 按 rect 裁图（模拟 app 裁图），输出 PNG 供目检 */
import fs from 'node:fs'
import m from 'mupdf'
import {
  orderLines, dropRunningHeads, reorderReferenceHeading,
  detectTableZones, detectAlgorithms, linesToBlocks
} from '../src/renderer/src/reflow.ts'

const src = process.argv[2] ?? 'scripts/fixtures/crop-boundary.pdf'
const outDir = 'C:/Users/admin/Desktop/逆向工程/paperlite/crops-fix'
fs.mkdirSync(outDir, { recursive: true })

const doc = m.Document.openDocument(new Uint8Array(fs.readFileSync(src)), 'application/pdf')
const perPage = []
const pages = []
for (let p = 0; p < doc.countPages(); p++) {
  const pg = doc.loadPage(p)
  pages.push(pg)
  const st = JSON.parse(pg.toStructuredText().asJSON())
  const lines = []
  for (const b of st.blocks) for (const l of b.lines ?? []) {
    const t = (l.text ?? '').replace(/\s+/g, ' ').trim()
    if (!t) continue
    const bb = l.bbox
    const words = t.split(/\s+/).filter(Boolean)
    const shortWords = words.filter((w) => w.replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, '').length <= 1).length
    let mc = 0
    for (const ch of t.replace(/\s/g, '')) if (/[\u2200-\u22FF\u2190-\u21FF\u2A00-\u2AFF\u{1D400}-\u{1D7FF}\u0370-\u03FF]/u.test(ch)) mc++
    const chars = t.replace(/\s/g, '')
    lines.push({ page: p + 1, yTop: bb.y, x0: bb.x, x1: bb.x + bb.w, fontSize: bb.h, text: t, html: t, mathRatio: 0, charMathRatio: chars.length ? mc / chars.length : 0, shortFragRatio: words.length ? shortWords / words.length : 0, fragCount: words.length, wordCount: words.length, eqNumbered: /\(\s*\d+\s*\)\s*$/.test(t) })
  }
  const b = pg.getBounds()
  perPage.push({ lines, height: b[3] - b[1], width: b[2] - b[0] })
}
const sizes = perPage.flatMap((p) => p.lines.map((l) => l.fontSize)).sort((a, b) => a - b)
const bodySize = sizes[Math.floor(sizes.length / 2)] || 12
const kept = dropRunningHeads(perPage)
const ordered = []
perPage.forEach((p, i) => ordered.push(...orderLines(kept[i], p.width)))
reorderReferenceHeading(ordered)
detectTableZones(ordered, bodySize)
detectAlgorithms(ordered, bodySize)
const blocks = linesToBlocks(ordered, bodySize)

// 渲染页并裁图
const SCALE = 3
const canvases = pages.map((pg) => {
  const pix = pg.toPixmap(m.Matrix.scale(SCALE, SCALE), m.ColorSpace.DeviceRGB)
  const png = pix.asPNG()
  const blob = new Uint8Array(png)
  return { pix, w: pix.getWidth(), h: pix.getHeight(), png: blob }
})

let n = 0
for (const b of blocks) {
  if (!b.rect || (b.kind !== 'table' && b.kind !== 'formula')) continue
  const cv = canvases[b.page - 1]
  const r = b.rect
  const pad = b.kind === 'formula' ? 2 : 4
  const x = Math.max(0, Math.floor((r.x0 - pad) * SCALE))
  const y = Math.max(0, Math.floor((r.y0 - pad) * SCALE))
  const w = Math.min(cv.w - x, Math.ceil((r.x1 - r.x0 + pad * 2) * SCALE))
  const h = Math.min(cv.h - y, Math.ceil((r.y1 - r.y0 + pad * 2) * SCALE))
  n++
  fs.writeFileSync(`${outDir}/crop-${String(n).padStart(2, '0')}-${b.kind}${b.role ? '-' + b.role : ''}-p${b.page}.json`,
    JSON.stringify({ x, y, w, h, scale: SCALE, page: b.page, text: b.text.slice(0, 60) }))
  fs.writeFileSync(`${outDir}/page-${b.page}.png`, cv.png)
}
console.log('blocks:', blocks.length, 'crops:', n)
