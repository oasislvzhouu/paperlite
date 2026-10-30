const BASE = 'http://127.0.0.1:9222'
const targets = await (await fetch(`${BASE}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let seq = 0
const pending = new Map()
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
function send(method, params = {}) { return new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) }) }
const evalJs = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await sleep(2500)
await evalJs(`document.querySelector('.open-btn').click()`)
await sleep(9000)

const w0 = await evalJs(`document.querySelector('#reflow-article').offsetWidth`)
const indent = await evalJs(`getComputedStyle(document.querySelector('#reflow-article p[data-bi]')).textIndent`)
console.log('[1] 默认宽度:', w0, 'px | 首行缩进:', indent)

await evalJs(`document.querySelector('#width-btn').click()`)
await sleep(300)
const w1 = await evalJs(`document.querySelector('#reflow-article').offsetWidth`)
console.log('[2] 切宽后:', w1, 'px（标签:', await evalJs(`document.querySelector('#width-btn').textContent`), '）')

await evalJs(`document.querySelector('#toc-btn').click()`)
await sleep(400)
const tocInfo = await evalJs(`JSON.stringify({ visible: !document.querySelector('#toc-panel').hidden, items: document.querySelectorAll('.toc-item').length, first: document.querySelector('.toc-item')?.textContent.slice(0, 40) })`)
console.log('[3] 目录:', tocInfo)

const j = JSON.parse(tocInfo)
if (j.items > 0) {
  const before = await evalJs(`document.querySelector('#page-input').value`)
  await evalJs(`document.querySelectorAll('.toc-item')[Math.min(3, j.items - 1)].click()`)
  await sleep(700)
  const after = await evalJs(`document.querySelector('#page-input').value`)
  console.log('[4] 目录跳页:', before, '→', after, after !== before ? '✓' : '（同级页码相同）')
}
const pass = w1 > w0 + 40 && indent !== '0px' && j.visible
console.log(pass ? '\n✓ 宽度/缩进/目录 全部工作' : '\n✗ 有问题')
ws.close()
process.exit(pass ? 0 : 1)
