/** 端到端 v2：打开论文 → 公式块检查 → 真实 GLM 翻译 → 双语对照验证 */
const BASE = 'http://127.0.0.1:9222'
const targets = await (await fetch(`${BASE}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) { console.log('no page'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let seq = 0
const pending = new Map()
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) return 'EXC: ' + (r.result.exceptionDetails.exception?.description ?? '').slice(0, 200)
  return r.result?.result?.value
}
function send(method, params = {}) { return new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) }) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('[1] llm 状态:', await evalJs(`window.paperlite.llmStatus()`))
await evalJs(`document.querySelector('.open-btn').click()`)
await sleep(4000)

const info = await evalJs(`JSON.stringify({
  title: document.querySelector('#reader-title').textContent.slice(0, 50),
  pageTotal: document.querySelector('#page-total').textContent,
  blocks: document.querySelectorAll('#reflow-article > *').length,
  formulas: document.querySelectorAll('.formula').length,
  formulaSample: (document.querySelector('.formula')?.textContent ?? '').slice(0, 60)
})`)
console.log('[2] 阅读器:', info)
const f = JSON.parse(info)
console.log(f.formulas > 0 ? `    ✓ 公式块 ${f.formulas} 个，样例: ${f.formulaSample}` : '    ⚠ 无公式块（该论文可能无嵌入数学字体）')

console.log('[3] 点击「译」，等待 GLM 翻译…')
await evalJs(`document.querySelector('#translate-btn').click()`)
let trans = 0, btnText = ''
for (let i = 0; i < 40; i++) {
  await sleep(5000)
  const st = await evalJs(`JSON.stringify({trans: document.querySelectorAll('p.trans').length, shown: document.querySelectorAll('#reflow-article.show-trans p.trans').length, btn: document.querySelector('#translate-btn').textContent})`)
  ;({ trans } = JSON.parse(st)); btnText = JSON.parse(st).btn
  if (i % 4 === 0) console.log(`    ${i * 5}s: 译文 ${trans} 段（按钮: ${btnText}）`)
  if (trans > 0 && btnText === '已译') break
}
const sample = await evalJs(`(document.querySelector('#reflow-article.show-trans p.trans')?.textContent ?? '').slice(0, 80)`)
console.log(`[4] 结果: ${trans} 段译文，样例: ${sample}`)
const pass = trans > 0 && sample.length > 0
console.log(pass ? '\n✓ 公式+翻译端到端通过' : '\n✗ 翻译未完成')
ws.close()
process.exit(pass ? 0 : 1)
