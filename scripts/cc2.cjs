const http = require('http')
const WebSocket = require('ws')
http.get('http://127.0.0.1:9222/json', (res) => {
  let d = ''
  res.on('data', (c) => (d += c))
  res.on('end', () => {
    const t = JSON.parse(d).filter((x) => x.type === 'page' && x.webSocketDebuggerUrl)[0]
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    let seq = 0
    const pending = new Map()
    const logs = []
    ws.on('message', (ev) => {
      const m = JSON.parse(ev)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
      if (m.method === 'Runtime.consoleAPICalled') {
        const txt = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
        if (/页面公式|MuPDF|渲染失败|pollut/i.test(txt)) logs.push(m.params.type + ': ' + txt.slice(0, 200))
      }
    })
    ws.on('open', async () => {
      const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
      const evalJs = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value
      await send('Runtime.enable')
      await evalJs('document.querySelector("#back-btn")?.click()')
      await new Promise((r) => setTimeout(r, 1500))
      await evalJs('document.querySelector(".open-btn").click()')
      await new Promise((r) => setTimeout(r, 45000))
      console.log('=== logs ===')
      logs.slice(0, 10).forEach((l) => console.log(l))
      console.log('katex:', await evalJs('document.querySelectorAll(".formula .katex").length'))
      ws.close()
      process.exit(0)
    })
  })
})
