const http = require('http')
const WebSocket = null // 占位避免误用

http.get('http://127.0.0.1:9222/json', (res) => {
  let d = ''
  res.on('data', (c) => (d += c))
  res.on('end', () => {
    const targets = JSON.parse(d).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (!targets.length) { console.log('no target'); process.exit(1) }
    start(targets[0].webSocketDebuggerUrl)
  })
})

function start(url) {
  const WebSocketCtor = require('ws')
  const ws = new WebSocketCtor(url)
  let seq = 0
  const pending = new Map()
  const events = []
  ws.on('message', (ev) => {
    const m = JSON.parse(ev)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    if (m.method === 'Runtime.exceptionThrown') {
      events.push('EXC: ' + (m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? 'unknown').slice(0, 300))
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      events.push('CONSOLE[' + m.params.type + ']: ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300))
    }
  })
  ws.on('open', () => run(ws, send, evalJsFactory(pending, send), events))
  function send(method, params = {}) {
    return new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
  }
  function evalJsFactory(pendingMap, sendFn) {
    return async (expression) => {
      const r = await sendFn('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      return r.result?.result?.value
    }
  }
  async function run(ws, send, evalJs, events) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    await evalJs(`document.querySelector('.open-btn').click()`)
    await sleep(30000)
    // 读取 console 事件（通过注入的窗口级记录不可行，直接读 CDP 事件缓存）
    console.log('=== events ===')
    events.slice(0, 30).forEach((e) => console.log(e))
    const st = await evalJs(`JSON.stringify({ blocks: document.querySelectorAll('#reflow-article > *').length })`)
    console.log('blocks:', st)
    ws.close()
    process.exit(0)
  }
}
