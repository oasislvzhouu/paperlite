/** 定位某段文字并截图（验证行内公式是否还成图） */
import fs from 'node:fs'

const BASE = 'http://127.0.0.1:9222'
const OUT = 'C:/Users/admin/Desktop/逆向工程/paperlite/crops6'
const NEEDLE = process.argv[2] ?? 'optimized Transformer'
const NAME = process.argv[3] ?? 'shot'

const targets = await (await fetch(`${BASE}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) { console.log('no page'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let seq = 0
const pending = new Map()
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })

const found = await ev(`(() => {
  const els = [...document.querySelectorAll('#reflow-article p, #reflow-article div.formula')]
  const el = els.find((x) => x.textContent.includes(${JSON.stringify(NEEDLE)}))
  if (!el) return 'not-found'
  el.scrollIntoView({ block: 'center' })
  return el.tagName + '.' + el.className
})()`)
console.log('found:', found)
await sleep(900)
const r = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(`${OUT}/${NAME}.png`, Buffer.from(r.result.data, 'base64'))

// 该区域内的公式块数量（应为 0：行内数学不该成图）
const near = await ev(`(() => {
  const el = [...document.querySelectorAll('#reflow-article p')].find((x) => x.textContent.includes(${JSON.stringify(NEEDLE)}))
  const art = document.querySelector('#reflow-article')
  const wrap = document.querySelector('#reflow-wrap')
  const mid = wrap.scrollTop + wrap.clientHeight / 2
  const hit = [...art.querySelectorAll('div.formula')].filter((f) => {
    const top = f.offsetTop
    return Math.abs(top - mid) < 260
  })
  return JSON.stringify({ blockText: el ? el.textContent.replace(/\\s+/g, ' ').slice(0, 200) : null, formulasNear: hit.map((f) => f.textContent.trim().slice(0, 30)) })
})()`)
console.log('near:', near)
ws.close()
process.exit(0)
