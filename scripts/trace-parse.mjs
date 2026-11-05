const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
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
await sleep(1500)
await evalJs(`document.querySelector('.open-btn').click()`)
// 追踪 90 秒内的解析进度
let last = ''
for (let i = 0; i < 18; i++) {
  await sleep(5000)
  const st = await evalJs(`JSON.stringify({
    t: ${(Date.now() - 1500) / 1000 | 0},
    chip: (document.querySelector('#trans-status-text')||{}).textContent || '(none)',
    blocks: document.querySelectorAll('#reflow-article > *').length,
    katex: document.querySelectorAll('.formula .katex').length,
    figImgs: document.querySelectorAll('figure.figure img').length
  })`)
  const j = JSON.parse(st)
  console.log(`${j.t}s chip="${j.chip.slice(0, 24)}" blocks=${j.blocks} katex=${j.katex} figImgs=${j.figImgs}`)
  last = st
  const j2 = JSON.parse(st)
  if (j2.figImgs > 20 && j2.katex > 5) { console.log('ALL DONE'); break }
}
const r2 = await send('Page.captureScreenshot', { format: 'png' })
const fs = await import('node:fs')
fs.writeFileSync('scripts/ui-audit/v3/v10-final.png', Buffer.from(r2.result.data, 'base64'))
ws.close()
process.exit(0)
