/** 单本导出（每次新进程，避免返回书架的重排干扰）。用法: node dump-one.mjs <标题片段> <label> */
import fs from 'node:fs'
import path from 'node:path'

const WANT = process.argv[2] ?? 'Trainable'
const LABEL = process.argv[3] ?? 'b0'
const BASE = 'http://127.0.0.1:9222'
const OUT = 'C:/Users/admin/Desktop/逆向工程/paperlite/crops3'
fs.mkdirSync(OUT, { recursive: true })

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

const ok = await ev(`(async () => {
  for (let k=0;k<80;k++){
    const cards=[...document.querySelectorAll('.card')]
    const c=cards.find(x=>x.querySelector('.card-title')?.textContent.includes(${JSON.stringify(WANT)}))
    if (c) { c.querySelector('.open-btn').click(); return true }
    await new Promise(r=>setTimeout(r,400))
  }
  return false
})()`)
console.log('clicked:', ok)
for (let k = 0; k < 60; k++) {
  await sleep(1000)
  const done = await ev(`(() => {
    const f = document.querySelectorAll('.formula').length
    const fi = document.querySelectorAll('.formula.formula-fidelity img').length
    const t = document.querySelectorAll('figure.table').length
    const ti = document.querySelectorAll('figure.table img').length
    const n = document.querySelectorAll('#reflow-article [data-bi]').length
    return n > 10 && (f === 0 || fi === f) && (t === 0 || ti === t) ? 'done' : 'pending'
  })()`)
  if (done === 'done') break
}
await sleep(2000)
const title = await ev(`document.querySelector('#reader-title')?.textContent ?? ''`)
console.log('opened:', title.slice(0, 50))

const meta = await ev(`(() => {
  const art = document.querySelector('#reflow-article'); const out = []; let curPage = 0
  const walk = (el) => { for (const ch of el.children) {
    if (ch.classList.contains('page-sep')) { curPage = Number(ch.dataset.page) || curPage; continue }
    const imgs = ch.tagName === 'IMG' ? [ch] : [...ch.querySelectorAll('img')]
    if (imgs.length) { const isF = ch.classList.contains('formula'), isA = ch.classList.contains('algorithm'), isT = ch.classList.contains('table')
      for (const im of imgs) out.push({ kind: isF ? 'formula' : isA ? 'algo' : isT ? 'table' : 'figure', page: curPage, bi: ch.dataset.bi ?? '', text: (ch.querySelector('figcaption')?.textContent ?? ch.textContent ?? '').slice(0,90), natural: im.naturalWidth + 'x' + im.naturalHeight })
    }
    if (ch.children.length && !ch.matches('figure, .formula')) walk(ch)
  } }
  walk(art); return JSON.stringify(out)
})()`)
const items = JSON.parse(meta)
for (let i = 0; i < items.length; i++) {
  const src = await ev(`(() => { const im = [...document.querySelectorAll('#reflow-article img')][${i}]; return im ? im.src : '' })()`)
  const b64 = src && src.includes(',') ? src.split(',')[1] : ''
  const ext = src?.startsWith('data:image/jpeg') ? 'jpg' : 'png'
  const file = b64 ? `${LABEL}-${String(i).padStart(2, '0')}-${items[i].kind}.${ext}` : ''
  if (b64) fs.writeFileSync(path.join(OUT, file), Buffer.from(b64, 'base64'))
  items[i].file = file
}
fs.writeFileSync(path.join(OUT, `${LABEL}-manifest.json`), JSON.stringify(items, null, 1))
console.log(LABEL, title.slice(0, 30), items.length, JSON.stringify(items.map((x) => x.kind).reduce((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {})))
ws.close()
process.exit(0)
