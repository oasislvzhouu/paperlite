/** 排版质量诊断：碎片段落数、平均段落长度、标题数、跨句断裂迹象 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractReflowBlocks } from '../src/renderer/src/reflow.ts'

const root = process.argv[2] ?? 'C:/Users/admin/Desktop/论文下载/downloads'
function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.toLowerCase().endsWith('.pdf')) out.push(p)
  }
  return out
}

console.log('论文'.padEnd(46), '块数  段落  碎片(≤4词)  平均词/段  标题  公式')
for (const f of walk(root).slice(0, 8)) {
  try {
    const task = getDocument({ data: new Uint8Array(readFileSync(f)) })
    const doc = await task.promise
    const proxy = { numPages: Math.min(doc.numPages, 8), getPage: (i) => doc.getPage(i) }
    const blocks = await extractReflowBlocks(proxy)
    const paras = blocks.filter((b) => b.kind === 'paragraph')
    const frags = paras.filter((b) => b.text.split(/\s+/).filter(Boolean).length <= 4)
    const avgWords = Math.round(
      paras.reduce((n, p) => n + p.text.split(/\s+/).filter(Boolean).length, 0) / Math.max(1, paras.length)
    )
    const name = f.split(/[\\/]/).pop().slice(0, 44)
    console.log(
      name.padEnd(46),
      String(blocks.length).padStart(4),
      String(paras.length).padStart(5),
      String(frags.length).padStart(8),
      String(avgWords).padStart(8),
      String(blocks.filter((b) => b.kind === 'heading').length).padStart(4),
      String(blocks.filter((b) => b.kind === 'formula').length).padStart(4)
    )
    await task.destroy()
  } catch (e) {
    console.log(f.split(/[\\/]/).pop().slice(0, 44), '✗', String(e.message).slice(0, 40))
  }
}
