/** 单书裁图导出（b2） */
import fs from 'node:fs'

const BASE = 'http://127.0.0.1:9222'
const OUT = 'C:/Users/admin/Desktop/逆向工程/paperlite/crops'
const BOOK_IDX = Number(process.argv[2] ?? 2)
const LABEL = process.argv[3] ?? 'b2-comparative'

const targets = await (await fetch(`${BASE}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) { console.log('no page'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let seq = 0
const pending = new Map()
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
const evalJs = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 等书架
const n = await evalJs(`(async () => { for (let k=0;k<60;k++){ const c=document.querySelectorAll('.open-btn').length; if (c>${BOOK_IDX}) return c; await new Promise(r=>setTimeout(r,400)) } return document.querySelectorAll('.open-btn').length })()`)
console.log('books:', n)
await evalJs(`document.querySelectorAll('.open-btn')[${BOOK_IDX}]?.click()`)
for (let k = 0; k < 45; k++) {
  await sleep(1000)
  const done = await evalJs(`(() => {
    const f = document.querySelectorAll('.formula').length
    const fi = document.querySelectorAll('.formula.formula-fidelity img').length
    const t = document.querySelectorAll('figure.table').length
    const ti = document.querySelectorAll('figure.table img').length
    const n = document.querySelectorAll('#reflow-article [data-bi]').length
    return n > 10 && (f === 0 || fi === f) && (t === 0 || ti === t) ? 'done' : 'pending'
  })()`)
  if (done === 'done') break
}
await sleep(1500)
const meta = await evalJs(`(() => {
  const art = document.querySelector('#reflow-article'); const out = []; let curPage = 0; let prevText = ''
  const walk = (el) => { for (const ch of el.children) {
    if (ch.classList.contains('page-sep')) { curPage = Number(ch.dataset.page) || curPage; continue }
    const imgs = ch.tagName === 'IMG' ? [ch] : [...ch.querySelectorAll('img')]
    if (imgs.length) { const isF = ch.classList.contains('formula'), isA = ch.classList.contains('algorithm'), isT = ch.classList.contains('table')
      for (const im of imgs) out.push({ kind: isF ? 'formula' : isA ? 'algo' : isT ? 'table' : 'figure', page: curPage, bi: ch.dataset.bi ?? '', text: (ch.querySelector('figcaption')?.textContent ?? ch.textContent ?? '').slice(0,120), prev: prevText.slice(-80), natural: im.naturalWidth + 'x' + im.naturalHeight })
    }
    const t = (ch.textContent ?? '').replace(/\s+/g,' ').trim(); if (t) prevText = t
    if (ch.children.length && !ch.matches('figure, .formula')) walk(ch)
  } }
  walk(art); return JSON.stringify(out)
})()`)
const items = JSON.parse(meta)
for (let i = 0; i < items.length; i++) {
  const src = await evalJs(`(() => { const im = [...document.querySelectorAll('#reflow-article img')][${i}]; return im ? im.src : '' })()`)
  const b64 = src && src.includes(',') ? src.split(',')[1] : ''
  const ext = src?.startsWith('data:image/jpeg') ? 'jpg' : 'png'
  const file = b64 ? `${LABEL}-${String(i).padStart(2,'0')}-${items[i].kind}.${ext}` : ''
  if (b64) fs.writeFileSync(`${OUT}/${file}`, Buffer.from(b64, 'base64'))
  items[i].file = file
  items[i].srcLen = src.length
}
fs.writeFileSync(`${OUT}/${LABEL}-manifest.json`, JSON.stringify(items, null, 1))
console.log(LABEL + ':', items.length, JSON.stringify(items.map(x=>x.kind).reduce((a,k)=>((a[k]=(a[k]??0)+1),a),{})))
ws.close(); process.exit(0)
