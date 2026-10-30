/** 裸 CDP 探针：在 PaperLite 渲染页上下文执行诊断，返回真实运行时状态 */
const BASE = 'http://127.0.0.1:9222'

const targets = await (await fetch(`${BASE}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) {
  console.log('targets:', targets.map((t) => `${t.type} ${t.url}`).join('\n'))
  process.exit(1)
}
console.log('page:', page.url)

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))

let seq = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}
function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (r.result?.exceptionDetails) return 'EXC: ' + JSON.stringify(r.result.exceptionDetails.exception?.description).slice(0, 400)
  return r.result?.result?.value
}

console.log('--- 基本状态 ---')
console.log('window.paperlite:', await evalJs(`typeof window.paperlite`))
console.log('卡片数:', await evalJs(`document.querySelectorAll('.card').length`))
console.log('img 状态:', await evalJs(`JSON.stringify([...document.querySelectorAll('.thumb img')].map(i => ({id: i.dataset.id, complete: i.complete, nw: i.naturalWidth, hidden: i.hidden})))`))
console.log('fallback 可见:', await evalJs(`[...document.querySelectorAll('.thumb-fallback')].filter(f => !f.hidden).length`))

console.log('--- 渲染页内 fetch paperlite:// ---')
console.log('thumb fetch:', await evalJs(`fetch('paperlite://thumb/1').then(r => 'status=' + r.status).catch(e => 'ERR ' + e.message)`))

console.log('--- pdf.js 状态 ---')
console.log('pdfjs 版本:', await evalJs(`(async () => { const m = await import('./assets/index-*.js').catch(() => null); return 'skip' })()`.replace(/.*/s, `(async () => {
  try {
    const w = pdfjsLib ?? null
  } catch {}
  return typeof pdfjsLib !== 'undefined' ? 'global ok' : 'no global (bundled)'
})()`)))

console.log('--- 直接在页面里跑一次 pdf.js 加载 ---')
console.log('load result:', await evalJs(`(async () => {
  try {
    const buf = await window.paperlite.getPdfBuffer ? 'has getPdfBuffer' : 'no getPdfBuffer'
    return buf + ' | workerPort set: ' + (typeof pdfjsLib !== 'undefined')
  } catch (e) { return 'ERR ' + e.message }
})()`))

// 直接测试：用页面里已加载的模块再开一次 PDF（通过 DOM 判断），并观察 10 秒内是否完成
console.log('generateThumb 复跑(id=1):', await evalJs(`(async () => {
  const t0 = performance.now()
  try {
    // 通过点击逻辑无法直接调用内部函数；改为直接 fetch pdf 并检查可读性
    const r = await fetch('paperlite://pdf/1')
    const len = (await r.arrayBuffer()).byteLength
    return 'pdf fetch ok, ' + len + ' bytes, ' + Math.round(performance.now() - t0) + 'ms'
  } catch (e) { return 'ERR ' + e.message + ' ' + Math.round(performance.now() - t0) + 'ms' }
})()`))

// 等待可能的异步缩略图生成
await new Promise((r) => setTimeout(r, 6000))
console.log('--- 6 秒后 ---')
console.log('img 状态:', await evalJs(`JSON.stringify([...document.querySelectorAll('.thumb img')].map(i => ({id: i.dataset.id, nw: i.naturalWidth, hidden: i.hidden})))`))

// 页面 console 历史拿不到，但可以拿当前异常计数：触发一次已知行为看 console 转发
ws.close()
process.exit(0)
