/** 裁图 rect 审计：公式/表格/算法块 rect vs 实际行范围 */
import fs from 'node:fs'
import path from 'node:path'
import m from 'mupdf'
import {
  orderLines, dropRunningHeads, reorderReferenceHeading,
  detectTableZones, detectAlgorithms, linesToBlocks
} from '../src/renderer/src/reflow.ts'

const arg = process.argv[2] ?? '0e8bfe1b'
const libDir = 'C:/Users/admin/AppData/Roaming/paperlite/library'
let filePath = arg
if (!fs.existsSync(arg)) {
  const file = fs.readdirSync(libDir).find((f) => f.startsWith(arg))
  filePath = path.join(libDir, file)
}
const doc = m.Document.openDocument(new Uint8Array(fs.readFileSync(filePath)), 'application/pdf')

const perPage = []
for (let p = 0; p < doc.countPages(); p++) {
  const pg = doc.loadPage(p)
  const stext = JSON.parse(pg.toStructuredText().asJSON())
  const lines = []
  for (const block of stext.blocks) {
    for (const l of block.lines ?? []) {
      const text = (l.text ?? '').replace(/\s+/g, ' ').trim()
      if (!text) continue
      const bb = l.bbox
      const words = text.split(/\s+/).filter(Boolean)
      const shortWords = words.filter((w) => w.replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, '').length <= 1).length
      let mathChars = 0
      for (const ch of text.replace(/\s/g, '')) {
        if (/[\u2200-\u22FF\u2190-\u21FF\u2A00-\u2AFF\u{1D400}-\u{1D7FF}\u0370-\u03FF]/u.test(ch)) mathChars++
      }
      const chars = text.replace(/\s/g, '')
      lines.push({
        page: p + 1, yTop: bb.y, x0: bb.x, x1: bb.x + bb.w, fontSize: bb.h, text,
        html: '', mathRatio: 0,
        charMathRatio: chars.length ? mathChars / chars.length : 0,
        shortFragRatio: words.length ? shortWords / words.length : 0,
        fragCount: words.length,
        wordCount: words.length,
        eqNumbered: /\(\s*\d+\s*\)\s*$/.test(text)
      })
    }
  }
  const bounds = pg.getBounds()
  perPage.push({ lines, height: bounds[3] - bounds[1], width: bounds[2] - bounds[0] })
}
const pages = doc.countPages()
doc.destroy()

const sizes = perPage.flatMap((p) => p.lines.map((l) => l.fontSize)).sort((a, b) => a - b)
const bodySize = sizes[Math.floor(sizes.length / 2)] || 10
const kept = dropRunningHeads(perPage)
const ordered = []
perPage.forEach((p, i) => ordered.push(...orderLines(kept[i], p.width)))
reorderReferenceHeading(ordered)
detectTableZones(ordered, bodySize)
detectAlgorithms(ordered, bodySize)
const blocks = linesToBlocks(ordered, bodySize)

console.log(`book=${arg} pages=${pages} bodySize=${bodySize.toFixed(1)} blocks=${blocks.length}`)
for (let i = 0; i < blocks.length; i++) {
  const b = blocks[i]
  if (b.kind !== 'table' && b.kind !== 'formula') continue
  const r = b.rect
  const h = r ? (r.y1 - r.y0).toFixed(0) : '-'
  console.log(
    `#${i} ${b.kind}${b.role ? '/' + b.role : ''} p${b.page} rect=${
      r ? `x[${r.x0.toFixed(0)},${r.x1.toFixed(0)}] y[${r.y0.toFixed(0)},${r.y1.toFixed(0)}] h=${h}` : 'none'
    } top=${b.top?.toFixed(0)} | ${b.text.slice(0, 60)}`
  )
}
