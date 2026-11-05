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
  katexFormulas: document.querySelectorAll('.formula .katex').length,
  formulaHtmlBlocks: [...document.querySelectorAll('.formula')].filter(f => f.querySelector('.katex')).length,
  formulas: document.querySelectorAll('.formula').length,
  figs: document.querySelectorAll('figure.figure').length,
  figImgs: document.querySelectorAll('figure.figure img').length,
  trans: document.querySelectorAll('p.trans').length,
  blocks: document.querySelectorAll('#reflow-article > *').length,
  headings: document.querySelectorAll('#reflow-article h1,h2,h3').length
})`)
console.log('LLM 页解析状态:', st)
const sample = await evalJs(`JSON.stringify([...document.querySelectorAll('.formula .katex')].slice(0, 2).map(f => f.textContent.slice(0, 50)))`)
console.log('KaTeX 样例:', sample)
ws.close()
process.exit(0)
