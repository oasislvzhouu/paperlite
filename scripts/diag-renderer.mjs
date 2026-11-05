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
  if (r.result?.exceptionDetails) return 'EXC: ' + (r.result.exceptionDetails.exception?.description ?? '').slice(0, 200)
  return r.result?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await sleep(1000)
// 1) 渲染进程里 mupdf 动态导入是否可用
console.log('mupdf 导入:', await evalJs(`import('mupdf').then(m => 'OK: ' + Object.keys(m).slice(0, 5).join(',')).catch(e => 'FAIL: ' + e.message)`))
// 2) 获取 PDF 数据
console.log('fetch pdf:', await evalJs(`fetch(window.paperlite.pdfUrl(1)).then(r => r.arrayBuffer()).then(b => 'bytes=' + b.byteLength).catch(e => 'FAIL ' + e.message)`))
// 3) mupdf 打开 + toStructuredText
console.log('mupdf 打开:', await evalJs(`Promise.all([import('mupdf'), fetch(window.paperlite.pdfUrl(1)).then(r => r.arrayBuffer())]).then(([m, buf]) => {
  const doc = m.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const pg = doc.loadPage(0)
  const st = JSON.parse(pg.toStructuredText().asJSON())
  return 'blocks=' + st.blocks.length + ' type0=' + st.blocks.filter(b => b.type === 'text').length
}).catch(e => 'FAIL: ' + e.message.slice(0, 120)))`))
// 4) toPixmap 渲染
console.log('toPixmap:', await evalJs(`Promise.all([import('mupdf'), fetch(window.paperlite.pdfUrl(1)).then(r => r.arrayBuffer())]).then(([m, buf]) => {
  const doc = m.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const pg = doc.loadPage(0)
  const pm = pg.toPixmap(m.Matrix.scale(2, 2), m.ColorSpace.RGB)
  return 'pixmap w=' + pm.getWidth() + ' h=' + pm.getHeight()
}).catch(e => 'FAIL: ' + e.message.slice(0, 120)))`))
ws.close()
process.exit(0)
