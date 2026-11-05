const http = require('http')
const WebSocket = require('ws')

http.get('http://127.0.0.1:9222/json', (res) => {
  let d = ''
  res.on('data', (c) => (d += c))
  res.on('end', () => {
    const targets = JSON.parse(d).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (!targets.length) { console.log('no target'); process.exit(1) }
    const ws = new WebSocket(targets[0].webSocketDebuggerUrl)
    const events = []
    let seq = 0
    const pending = new Map()
    ws.on('message', (ev) => {
      const m = JSON.parse(ev)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
      if (m.method === 'Runtime.consoleAPICalled') {
        events.push('CONSOLE: ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 260))
      }
      if (m.method === 'Runtime.exceptionThrown') {
        events.push('EXC: ' + (m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? 'unknown').slice(0, 260))
      }
    })
    ws.on('open', () => {
      const send = (method, params = {}) =>
        new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
      const evalJs = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
        return r.result?.result?.value
      }
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      ;(async () => {
        await send('Runtime.enable')
        // 重新打开论文并监听全程 console
        await evalJs(`(() => {
          window.__cap = []
          const orig = console.error.bind(console)
          console.error = (...a) => { window.__cap.push(a.map(x => String(x)).join(' ').slice(0, 250)); orig(...a) }
          console.warn = (...a) => { window.__cap.push('WARN ' + a.map(x => String(x)).join(' ').slice(0, 250)) }
        })()`)
        await evalJs(`document.querySelector('#back-btn').click()`)
        await sleep(1500)
        await evalJs(`document.querySelector('.open-btn').click()`)
        await sleep(60000)
        const errs = await evalJs(`JSON.stringify({ cap: window.__cap.slice(0, 20), blocks: document.querySelectorAll('#reflow-article > *').length })`)
        console.log(errs)
        ws.close()
        process.exit(0)
      })()
    })
  })
})
