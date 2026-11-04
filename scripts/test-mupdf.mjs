/** MuPDF 提取层验证：行提取 → 复用现有下游管线（列锚/段落/标题/表注） */
import * as mupdf from 'mupdf'
import { readFileSync } from 'node:fs'
import {
  dropRunningHeads,
  orderLines,
  detectTableZones,
  linesToBlocks
} from '../src/renderer/src/reflow.ts'

const f = 'C:/Users/admin/Desktop/论文下载/downloads/2026-10-28/ieee/A Novel Multiscale Residual Active Deep Q-Learning Network for Intelli.pdf'
const data = readFileSync(f)
const doc = mupdf.Document.openDocument(data, 'application/pdf')

function mupdfToLines(page, pageNo) {
  const stext = JSON.parse(page.toStructuredText().asJSON())
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
        page: pageNo,
        yTop: bb.y,
        x0: bb.x,
        x1: bb.x + bb.w,
        fontSize: bb.h,
        text,
        html: text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
        mathRatio: 0,
        charMathRatio: chars.length ? mathChars / chars.length : 0,
        shortFragRatio: words.length ? shortWords / words.length : 0,
        fragCount: words.length,
        eqNumbered: /\(\s*\d+\s*\)\s*$/.test(text)
      })
    }
  }
  return lines
}

const perPage = []
const numPages = Math.min(doc.countPages(), 6)
for (let p = 1; p <= numPages; p++) {
  const page = doc.loadPage(p - 1)
  const bounds = page.getBounds()
  const lines = mupdfToLines(page, p)
  const kept = dropRunningHeads([{ lines, height: bounds[3] - bounds[1] }])
  perPage.push({ lines: kept[0], height: bounds[3] - bounds[1], width: bounds[2] - bounds[0] })
}

const ordered = []
perPage.forEach((p, i) => ordered.push(...orderLines(p.lines, p.width)))
detectTableZones(ordered, 10)
const blocks = linesToBlocks(ordered, 10)

// 质量断言
let pass = 0
const t = (k, v) => { console.log(v ? 'PASS' : 'FAIL', k); if (v) pass++ }
t('III 标题完整', blocks.some((b) => b.text.includes('III. PROPOSED MRADQN-BASED BFD METHOD')))
t('II 标题完整', blocks.some((b) => b.text.includes('II. BACKGROUND')))
t('i i i a 碎片消失', !blocks.some((b) => b.text.includes('i i i a')))
t('无交错（列表顺序 1)→2)→3))', (() => {
  const i1 = blocks.findIndex((b) => b.text.includes('1) An active Q-learning'))
  const i2 = blocks.findIndex((b) => b.text.includes('2) A newly developed multiscale'))
  const i3 = blocks.findIndex((b) => b.text.includes('3) A novel MRADQN'))
  return i1 > -1 && i2 > i1 && i3 > i2
})())
t('表格块生成', blocks.some((b) => b.kind === 'table'))
const dqn = blocks.find((b) => b.text.includes('two networks (namely main net'))
t('DQN 段落连贯', dqn ? !/Q\(s, a; θ\) and Q\(s′/.test(dqn.text) : false)
console.log(pass + '/6')

// 显示前 10 块
blocks.slice(0, 10).forEach((b, i) => console.log(' #' + i, b.kind, b.role ?? '-', 'p' + b.page, JSON.stringify(b.text.slice(0, 44))))
