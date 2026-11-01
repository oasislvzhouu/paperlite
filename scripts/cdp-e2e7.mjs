/** 三合一 e2e：高亮/笔记 + 文内搜索 + 图片恢复 */
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
const evalJs = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await sleep(3000)
await evalJs(`document.querySelector('.open-btn').click()`)
await sleep(12000)

// ── 1) 高亮：程序化选区 → mouseup → 点「高亮」
const selOk = await evalJs(`(() => {
  const p = document.querySelector('#reflow-article p[data-bi]')
  if (!p || !p.textContent || p.textContent.length < 40) return 'no-p'
  const range = document.createRange()
  range.setStart(p.firstChild, 5); range.setEnd(p.firstChild, 25)
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range)
  p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  return 'selected:' + sel.toString().slice(0, 20)
})()`)
console.log('[1] 选区:', selOk)
await sleep(400)
const popVisible = await evalJs(`!document.querySelector('#hl-pop').hidden`)
console.log('[2] 浮动菜单出现:', popVisible)
if (popVisible) {
  await evalJs(`document.querySelector('#hl-pop button[data-act="hl"]').click()`)
  await sleep(800)
}
const hlCount = await evalJs(`document.querySelectorAll('#reflow-article mark.hl').length`)
console.log('[3] 高亮 mark 渲染:', hlCount)

// ── 2) 搜索
await evalJs(`document.querySelector('#search-btn').click()`)
await sleep(200)
await evalJs(`document.querySelector('#search-input').value = 'learning'`)
await evalJs(`document.querySelector('#search-input').dispatchEvent(new Event('input'))`)
await sleep(600)
const searchState = await evalJs(`JSON.stringify({ count: document.querySelector('#search-count').textContent, hits: document.querySelectorAll('.search-hit').length, current: document.querySelector('.search-current')?.textContent.slice(0, 30) })`)
console.log('[4] 搜索:', searchState)

// ── 3) 图片（worker 顺序修复验证）
await sleep(15000)
const imgState = await evalJs(`JSON.stringify({ figs: document.querySelectorAll('figure.figure').length, rects: globalThis.__plImgRects ?? null, renderErr: globalThis.__plImgRenderErr ?? null })`)
console.log('[5] 图片:', imgState)

ws.close()
process.exit(0)
