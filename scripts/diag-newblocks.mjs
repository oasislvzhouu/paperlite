/** 诊断：算法框/参考文献检测在真实 PDF 上的行级判定
 * 用法：node scripts/diag-newblocks.mjs [库内文件名前8位，默认 0e8bfe1b] */
import m from 'mupdf'
import fs from 'node:fs'
import path from 'node:path'
import {
  orderLines,
  dropRunningHeads,
  reorderReferenceHeading,
  detectTableZones,
  detectAlgorithms,
  linesToBlocks,
  markReferences
} from '../src/renderer/src/reflow.ts'

const dir = path.join(process.env.APPDATA, 'paperlite', 'library')
const prefix = process.argv[2] ?? '0e8bfe1b'
const file = fs.readdirSync(dir).find((f) => f.startsWith(prefix))
if (!file) { console.log('no pdf for', prefix); process.exit(1) }

const doc = m.Document.openDocument(new Uint8Array(fs.readFileSync(path.join(dir, file))), 'application/pdf')
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
        eqNumbered: /\(\s*\d+\s*\)\s*$/.test(text)
      })
    }
  }
  const bounds = pg.getBounds()
  perPage.push({ lines, height: bounds[3] - bounds[1], width: bounds[2] - bounds[0] })
}
doc.destroy()

const sizes = perPage.flatMap((p) => p.lines.filter((l) => !l.image).map((l) => l.fontSize)).sort((a, b) => a - b)
const bodySize = sizes[Math.floor(sizes.length / 2)] || 10
const ordered = []
perPage.forEach((p, i) => ordered.push(...orderLines(dropRunningHeads(perPage)[i], p.width)))

// 1) Algorithm 表题行的上下文（打印表题后 260pt 内的所有行 = 伪代码体）
console.log('== Algorithm 行上下文 ==')
ordered.forEach((l, i) => {
  if (/algorithm\s*\d/i.test(l.text)) {
    for (let k = Math.max(0, i - 1); k <= Math.min(ordered.length - 1, i + 20); k++) {
      const x = ordered[k]
      if (x.page !== l.page || x.yTop > l.yTop + 260) break
      console.log(
        `  p${x.page} yTop=${x.yTop.toFixed(0)} x0=${x.x0.toFixed(0)} fs=${x.fontSize.toFixed(1)} cmr=${x.charMathRatio.toFixed(2)} frag=${x.fragCount} eqCollect=${!!x.eqCollect} | ${x.text.slice(0, 70)}`
      )
    }
    console.log('  ---')
  }
})

// 2) References 标题行
console.log('== References 行 ==')
ordered.forEach((l) => {
  if (/^\s*(references?|bibliography)\s*$/i.test(l.text.trim())) {
    console.log(`  p${l.page} fs=${l.fontSize.toFixed(1)} bodySize=${bodySize.toFixed(1)} | "${l.text}"`)
  }
})

// 3) 跑完整判定
reorderReferenceHeading(ordered)
{
  const ri = ordered.findIndex((x) => x.text.trim() === 'REFERENCES')
  console.log('reorder 后 REFERENCES 行号=', ri, 'isRefStart=', ordered[ri]?.isRefStart)
  for (let k = Math.max(0, ri - 3); k <= Math.min(ordered.length - 1, ri + 3); k++) {
    console.log('  R' + k, 'p' + ordered[k].page, 'y=' + ordered[k].yTop.toFixed(0), 'x0=' + ordered[k].x0.toFixed(0), '"' + ordered[k].text.slice(0, 50) + '"')
  }
}
detectTableZones(ordered, bodySize)
const algoBefore = ordered.filter((l) => /algorithm\s*\d/i.test(l.text)).length
detectAlgorithms(ordered, bodySize)
console.log(`\ndetectAlgorithms: 候选行 ${algoBefore}，命中 tableAlgo=${ordered.filter((l) => l.tableAlgo).length}`)

const blocks = linesToBlocks(ordered, bodySize)
markReferences(blocks)
const tbl = blocks.filter((b) => b.kind === 'table')
const algo = blocks.filter((b) => b.role === 'algorithm')
const refs = blocks.filter((b) => b.role === 'ref-entry')
console.log(`table 块=${tbl.length}（算法框=${algo.length}）ref-entry=${refs.length}`)
console.log('References 附近的块:')
blocks.forEach((b, i) => {
  const pos = b.text.toUpperCase().indexOf('REFERENCES')
  if (pos >= 0) {
    console.log(`  #${i} [${b.kind}](${b.role ?? ''}) p${b.page} REF@${pos}`)
    console.log('    上下文: "…' + b.text.slice(Math.max(0, pos - 40), pos + 90) + '"')
  }
})
console.log('  ref-entry 总数:', blocks.filter((b) => b.role === 'ref-entry').length)
