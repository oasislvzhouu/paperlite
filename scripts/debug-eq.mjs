import { readFileSync } from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const f = 'C:/Users/admin/Desktop/论文下载/downloads/2026-10-28/ieee/A Novel Multiscale Residual Active Deep Q-Learning Network for Intelli.pdf'
const task = getDocument({ data: new Uint8Array(readFileSync(f)) })
const doc = await task.promise

// 第 3 页有一段 "formulated as follows:" + 公式，打印其附近所有文本项（含字体/字号）
const page = await doc.getPage(3)
const tc = await page.getTextContent()
let found = false
const lines = []
let curY = null
for (const it of tc.items) {
  if (!('str' in it) || !it.str.trim()) continue
  const y = Math.round(it.transform[5])
  if (curY !== y && lines.length) { /* new line group */ }
  curY = y
  lines.push({ y, x: Math.round(it.transform[4]), s: it.str })
  if (it.str.includes('formulated as follows')) found = true
}
// 按 y 分组打印 found 附近的 8 行
const groups = new Map()
for (const l of lines) {
  const k = l.y
  if (!groups.has(k)) groups.set(k, [])
  groups.get(k).push(l)
}
const ys = [...groups.keys()].sort((a, b) => b - a)
const idx = ys.findIndex((y) => groups.get(y).some((l) => l.s.includes('formulated as follows')))
for (const y of ys.slice(Math.max(0, idx - 1), idx + 8)) {
  const g = groups.get(y).sort((a, b) => a.x - b.x)
  const text = g.map((l) => l.s).join(' | ')
  const mathy = [...text.replace(/\s/g, '')].filter((c) => /[\u2200-\u22FF\u2190-\u21FF\u{1D400}-\u{1D7FF}\u0370-\u03FF]/u.test(c)).length
  console.log(`y=${y} math字符=${mathy} : ${text.slice(0, 90)}`)
}
await task.destroy()
