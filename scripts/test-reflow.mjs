/**
 * Reflow 引擎端到端验证（Node 24 原生 TS 类型剥离，无需编译）：
 *   python scripts/make_test_pdf.py && node scripts/test-reflow.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractReflowBlocks } from '../src/renderer/src/reflow.ts'

const here = dirname(fileURLToPath(import.meta.url))
const pdfPath = join(here, 'fixtures', 'reflow-test.pdf')

const data = new Uint8Array(readFileSync(pdfPath))
const doc = await getDocument({ data, isEvalSupported: false, useSystemFonts: false }).promise
const blocks = await extractReflowBlocks(doc)

const texts = blocks.map((b) => b.text)
const findIdx = (needle) => texts.findIndex((t) => t.includes(needle))

let failures = 0
function assert(name, cond) {
  if (cond) {
    console.log(`PASS  ${name}`)
  } else {
    console.error(`FAIL  ${name}`)
    failures++
  }
}

// 1. 标题识别
assert(
  '标题被识别为 heading',
  blocks.some((b) => b.kind === 'heading' && b.text.includes('A Study of Reflow Engines'))
)

// 2. 双栏阅读顺序：左栏在前，右栏在后
const li = findIdx('Reflow engines reconstruct')
const ri = findIdx('Right column line one alpha')
assert('双栏顺序：左栏段落先于右栏', li !== -1 && ri !== -1 && li < ri)

// 3. 行合并为段落
assert(
  '同一分栏的三行合并成一个段落',
  li !== -1 &&
    texts[li] === 'Reflow engines reconstruct the reading order of two column academic papers.'
)

// 4. 垂直间距触发分段
const i2 = findIdx('Second paragraph starts here')
assert('段间距后另起新段', i2 !== -1 && i2 !== li && texts[i2].startsWith('Second paragraph'))

// 5. 页眉（重复 3 页）被过滤
assert('重复页眉被过滤', !texts.some((t) => t.includes('Sample Journal of Testing')))

// 6. 页码（Page N）被过滤
assert('页码被过滤', !texts.some((t) => /^Page \d$/.test(t.trim())))

// 7. 连字符跨行合并
const hi = findIdx('phenation')
assert(
  '连字符跨行合并为一个单词',
  hi !== -1 && texts[hi].includes('hy- phenation') === false && texts[hi].includes('hyphenation join')
)

// 8. 跨页阅读流顺序：第 1 页右栏内容在第 2 页内容之前（段落允许跨栏/跨页连续合并）
const joined = texts.join('\n')
const p1r = joined.indexOf('Right column line three ends.')
const p2i = joined.indexOf('Page two left column text')
assert('跨页阅读流顺序正确（第 1 页右栏先于第 2 页）', p1r !== -1 && p2i !== -1 && p1r < p2i)

console.log(`\n${blocks.length} blocks, ${failures} failures`)
if (failures > 0) {
  console.log('--- blocks dump ---')
  blocks.forEach((b, i) => console.log(i, b.kind, `p${b.page}`, JSON.stringify(b.text.slice(0, 72))))
  process.exit(1)
}
process.exit(0)
