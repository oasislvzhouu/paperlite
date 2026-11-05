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
await send('Runtime.enable')
await send('Log.enable')
const consoleEvents = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.method === 'Runtime.consoleAPICalled') {
    consoleEvents.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200))
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleEvents.push('EXC: ' + (m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 250))
  }
  if (m.method === 'Log.entryAdded') {
    consoleEvents.push('LOG[' + m.params.entry.level + ']: ' + (m.params.entry.text ?? '').slice(0, 200))
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(1500)
await evalJs(`document.querySelector('.open-btn').click()`)
await sleep(30000)
console.log('=== 渲染进程 console（打开论文后 30 秒）===')
for (const e of consoleEvents.slice(0, 25)) console.log(e)
ws.close()
process.exit(0)
