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
await sleep(1000)
await evalJs(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent === '排版')
  if (btn) btn.click()
  // 滚到公式 (1) 位置
  const el = [...document.querySelectorAll('#reflow-article p, #reflow-article .formula')].find(e => e.textContent.includes('minimizing the loss function') || e.textContent.includes('L(θ'))
  if (el) el.scrollIntoView({ block: 'center' })
})()`)
await sleep(1000)
const r = await send('Page.captureScreenshot', { format: 'png' })
const fs = await import('node:fs')
fs.writeFileSync('scripts/ui-audit/v3/v7-formula-zone.png', Buffer.from(r.result.data, 'base64'))
console.log('saved')
ws.close()
process.exit(0)
