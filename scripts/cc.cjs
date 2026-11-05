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
        if (/mupdf|MuPDF|渲染|page|识别/i.test(txt)) logs.push(m.params.type + ': ' + txt.slice(0, 220))
      }
      if (m.method === 'Runtime.exceptionThrown') {
        logs.push('EXC: ' + (m.params.exceptionDetails?.exception?.description ?? '').slice(0, 220))
      }
    })
    ws.on('open', async () => {
      const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
      await send('Runtime.enable')
      // 直接手工调用一次页面渲染链路验证
      const r = await send('Runtime.evaluate', {
        expression: `(async () => {
          try {
            const m = await import('mupdf')
            const res = await fetch(window.paperlite.pdfUrl(1))
            const buf = new Uint8Array(await res.arrayBuffer())
            const doc = m.Document.openDocument(buf, 'application/pdf')
            const pg = doc.loadPage(3)
            const pm = pg.toPixmap(m.Matrix.scale(2,2), m.ColorSpace.DeviceRGB)
            const png = pm.asPNG()
            return 'OK png=' + png.length
          } catch (e) { return 'FAIL: ' + (e && e.message ? e.message : String(e)).slice(0, 200) }
        })()`,
        returnByValue: true,
        awaitPromise: true
      })
      console.log('手工渲染测试:', r.result?.result?.value ?? r.result)
      console.log('=== 相关 console ===')
      logs.slice(0, 12).forEach((l) => console.log(l))
      ws.close()
      process.exit(0)
    })
  })
})
