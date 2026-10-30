import { readFileSync } from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractReflowBlocks } from '../src/renderer/src/reflow.ts'

const file = process.argv[2]
const task = getDocument({ data: new Uint8Array(readFileSync(file)), isEvalSupported: false })
const real = await task.promise
const doc = { numPages: Math.min(real.numPages, 5), getPage: (i) => real.getPage(i) }
const blocks = await extractReflowBlocks(doc)

console.log('=== 正文块序列（跳过前 4 块元数据）===')
blocks.slice(4, 30).forEach((b, i) => {
  const tag = b.kind === 'heading' ? 'H' : ' '
  console.log(`${String(i + 4).padStart(3)} ${tag} p${b.page} ${b.text.slice(0, 66).replace(/\s+/g, ' ')}`)
})

const secRe = /^([IVX]+)\.\s+[A-Z]/
const secs = blocks.map((b, i) => ({ i, t: b.text })).filter((x) => secRe.test(x.t))
console.log('\n=== 章节标题出现顺序 ===')
secs.forEach((s) => console.log(s.i, s.t.slice(0, 50)))

const joined = blocks.map((b) => b.text).join(' ')
for (const p of ['reinforce-', 'diagnos-', 'learn-']) {
  console.log(`连字符"${p}"残留:`, joined.includes(p + ' ') ? '存在(未合并)' : '无')
}
await task.destroy()
