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
await sleep(500)
// 滚到第 3 页公式区
await evalJs(`(() => {
  const els = [...document.querySelectorAll('.formula')]
  const f = els.find(e => e.textContent.includes('θ') || e.textContent.includes('γ'))
  if (f) f.scrollIntoView({ block: 'center' })
  else {
    const p = [...document.querySelectorAll('#reflow-article p')].find(e => e.textContent.includes('loss function'))
    if (p) p.scrollIntoView({ block: 'center' })
  }
})()`)
await sleep(800)
const r = await send('Page.captureScreenshot', { format: 'png' })
const fs = await import('node:fs')
fs.writeFileSync('scripts/ui-audit/v3/v12-mupdf-formula.png', Buffer.from(r.result.data, 'base64'))
console.log('saved')
ws.close()
process.exit(0)
