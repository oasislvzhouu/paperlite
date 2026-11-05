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
// 滚到公式 (1)(2)(3) 区域并截图
await evalJs(`(() => {
  const els = [...document.querySelectorAll('.formula')]
  const f = els.find(e => e.textContent.includes('γmax') || e.textContent.includes('γ max'))
  if (f) f.scrollIntoView({ block: 'center' })
  else {
    const p = [...document.querySelectorAll('#reflow-article p')].find(e => e.textContent.includes('minimizing the loss function'))
    if (p) p.scrollIntoView({ block: 'center' })
  }
})()`)
await new Promise((r2) => setTimeout(r2, 1000))
const r = await send('Page.captureScreenshot', { format: 'png' })
const fs = await import('node:fs')
fs.writeFileSync('scripts/ui-audit/v3/v8-formula-mupdf.png', Buffer.from(r.result.data, 'base64'))
console.log('saved')
// KaTeX 检查
console.log(await evalJs(`JSON.stringify({
  katexBlocks: document.querySelectorAll('.formula.katex-ok').length,
  formulas: document.querySelectorAll('.formula').length,
  figImgs: document.querySelectorAll('figure.figure img').length,
  figs: document.querySelectorAll('figure.figure').length,
  trans: document.querySelectorAll('p.trans').length
})`))
ws.close()
process.exit(0)
