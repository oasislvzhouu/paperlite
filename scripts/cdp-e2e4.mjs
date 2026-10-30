/** KaTeX 公式升级端到端：打开 → 等识别 → 验证 .katex-ok */
const BASE = 'http://127.0.0.1:9222'
const targets = await (await fetch(`${BASE}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) { console.log('no page'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let seq = 0
const pending = new Map()
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
function send(method, params = {}) { return new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) }) }
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await sleep(3000)
const idx = await evalJs(`[...document.querySelectorAll('.card-title')].findIndex(t => t.textContent.includes('Multiscale'))`)
console.log('打开 Multiscale 论文（卡片', idx, '）…')
await evalJs(`document.querySelectorAll('.open-btn')[${idx < 0 ? 0 : idx}].click()`)
await sleep(9000)

console.log('等待 LLM 公式识别…')
let ok = 0, total = 0
for (let i = 0; i < 30; i++) {
  await sleep(5000)
  const st = await evalJs(`JSON.stringify({
    katexOk: document.querySelectorAll('.formula.katex-ok').length,
    formulas: document.querySelectorAll('.formula').length,
    visibleFormulas: [...document.querySelectorAll('.formula')].filter(f => f.style.display !== 'none').length
  })`)
  ;({ katexOk: ok, formulas: total } = JSON.parse(st))
  if (i % 3 === 0) console.log(`  ${i * 5}s: KaTeX ${ok}/${total}`)
  if (ok > 0 && ok >= total - 1) break
}

const samples = await evalJs(`JSON.stringify([...document.querySelectorAll('.formula.katex-ok')].slice(0, 3).map(f => f.getAttribute('title').slice(0, 90)))`)
console.log('LaTeX 样例:', samples)
const pass = ok >= 3
console.log(pass ? `\n✓ 公式 LaTeX 化成功（${ok} 个 KaTeX）` : '\n✗ 识别不足')
ws.close()
process.exit(pass ? 0 : 1)
