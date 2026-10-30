/** 批量评测：对目录下所有 PDF 跑重排引擎，输出结构与质量指标 */
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractReflowBlocks } from '../src/renderer/src/reflow.ts'

const root = process.argv[2]
const PAGE_LIMIT = Number(process.argv[3] ?? 8)
function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.toLowerCase().endsWith('.pdf')) out.push(p)
  }
  return out
}
const files = walk(root)

console.log(`found ${files.length} PDFs (page limit ${PAGE_LIMIT})\n`)

for (const file of files) {
  const name = basename(file)
  const sizeMB = (statSync(file).size / 1048576).toFixed(1)
  const t0 = Date.now()
  try {
    const data = new Uint8Array(readFileSync(file))
    const task = getDocument({ data, isEvalSupported: false })
    const real = await task.promise
    const numPages = real.numPages
    const doc = {
      numPages: Math.min(numPages, PAGE_LIMIT),
      getPage: (i) => real.getPage(i)
    }
    const blocks = await extractReflowBlocks(doc)
    const ms = Date.now() - t0
    const chars = blocks.reduce((n, b) => n + b.text.length, 0)
    const headings = blocks.filter((b) => b.kind === 'heading').length
    const cjk = blocks.reduce((n, b) => n + (b.text.match(/[\u4e00-\u9fff]/g)?.length ?? 0), 0)
    const paras = blocks.length - headings
    console.log(`${'='.repeat(70)}`)
    console.log(`${name}  [${sizeMB}MB, ${numPages}页→测${doc.numPages}, ${ms}ms]`)
    console.log(
      `  块:${blocks.length} (段落${paras}/标题${headings})  字符:${chars}  CJK占比:${((cjk / Math.max(1, chars)) * 100).toFixed(0)}%`
    )
    if (chars < 200) {
      console.log(`  ⚠ 文字层极少（可能是扫描件）`)
    }
    for (const b of blocks.slice(0, 4)) {
      const tag = b.kind === 'heading' ? 'H' : 'P'
      console.log(`  ${tag} p${b.page} ${b.text.slice(0, 60).replace(/\s+/g, ' ')}`)
    }
    await task.destroy()
  } catch (e) {
    console.log(`${'='.repeat(70)}`)
    console.log(`${name}  [${sizeMB}MB]  ✗ 失败: ${String(e.message ?? e).slice(0, 90)}`)
  }
}
