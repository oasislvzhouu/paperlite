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
const st = await evalJs(`JSON.stringify({
  katex: document.querySelectorAll('.formula.katex-ok').length,
  formulas: document.querySelectorAll('.formula').length,
  wenHao: [...document.querySelectorAll('.formula')].filter(f => f.textContent.includes('¿')).length
})`)
console.log('KaTeX 状态:', st)
ws.close()
process.exit(0)
