/** v3 验证：图片块 + sub/sup 标记 + 公式 */
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
// 打开有图的 Multiscale 论文（卡片顺序可能变化，按标题找）
const idx = await evalJs(`[...document.querySelectorAll('.card-title')].findIndex(t => t.textContent.includes('Multiscale'))`)
console.log('目标卡片索引:', idx)
await evalJs(`document.querySelectorAll('.open-btn')[${idx < 0 ? 0 : idx}].click()`)
await sleep(6000)

const info = await evalJs(`JSON.stringify({
  title: document.querySelector('#reader-title').textContent.slice(0, 40),
  blocks: document.querySelectorAll('#reflow-article > *').length,
  figures: document.querySelectorAll('figure.figure').length,
  figureImgs: document.querySelectorAll('figure.figure img').length,
  firstImgOk: (document.querySelector('figure.figure img')?.naturalWidth ?? 0) > 50,
  formulas: document.querySelectorAll('.formula').length,
  subs: document.querySelectorAll('#reflow-article sub').length,
  sups: document.querySelectorAll('#reflow-article sup').length,
  formulaWithSub: [...document.querySelectorAll('.formula')].filter(f => f.querySelector('sub,sup')).length
})`)
console.log('v3 阅读器状态:', info)
const j = JSON.parse(info)
const pass = j.figures > 0 && j.firstImgOk && j.formulas > 0 && (j.subs + j.sups) > 0
console.log(pass ? '\n✓ 图片提取 + 上下标 + 公式 全部生效' : '\n✗ 有缺失，见上')
ws.close()
process.exit(pass ? 0 : 1)
