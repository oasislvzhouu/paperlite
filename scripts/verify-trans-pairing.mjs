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
// 滚到 B 节第一段的译文处（刷新后译文应自动恢复在正确位置）
const st = await evalJs(`(() => {
  const paras = [...document.querySelectorAll('#reflow-article p[data-bi]')]
  const target = paras.find(p => p.textContent.includes('Q-learning, which depends on a Q-table'))
  if (target) target.scrollIntoView({ block: 'center' })
  const trans = [...document.querySelectorAll('p.trans')]
  return JSON.stringify({
    transCount: trans.length,
    first3: trans.slice(0, 3).map(t => t.textContent.slice(0, 34)),
    // 关键验证：Q-table 段的译文是否紧跟在该段之后
    qtablePara: paras.findIndex(p => p.textContent.includes('Q-learning, which depends on a Q-table')),
    qtableTransNext: (() => {
      const p = paras.find(p => p.textContent.includes('Q-learning, which depends on a Q-table'))
      if (!p) return null
      const nx = p.nextElementSibling
      return nx && nx.classList.contains('trans') ? nx.textContent.slice(0, 34) : 'NO-TRANS-AFTER'
    })()
  })
})()`)
console.log(st)
ws.close()
process.exit(0)
