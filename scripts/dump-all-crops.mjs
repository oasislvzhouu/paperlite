/** 三本书全量裁图导出（安全版：只用 #back-btn 返回，绝不按按钮文字匹配） */
import fs from 'node:fs'
import path from 'node:path'

const BASE = 'http://127.0.0.1:9222'
const OUT = 'C:/Users/admin/Desktop/逆向工程/paperlite/crops2'
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

const nBooks = await ev(`(async () => { for (let k=0;k<60;k++){ const c=document.querySelectorAll('.open-btn').length; if (c>=3) return c; await new Promise(r=>setTimeout(r,400)) } return document.querySelectorAll('.open-btn').length })()`)
console.log('books:', nBooks)

const titles = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.card-title')].map(t => t.textContent.trim()))`))
console.log('titles:', titles.length)
const manifest = []
for (let b = 0; b < Math.min(titles.length, 3); b++) {
  await ev(`document.querySelector('#back-btn')?.click()`)
  await sleep(900)
  const prevLen = await ev(`document.querySelector('#reflow-article')?.innerHTML.length ?? 0`)
  await ev(`(() => {
    const t = ${JSON.stringify(titles[b])}
    const card = [...document.querySelectorAll('.card')].find(c => c.querySelector('.card-title')?.textContent.trim() === t)
    card?.querySelector('.open-btn')?.click()
    return !!card
  })()`)
  // 等文章 DOM 真正换掉（#reader-title 隐藏后仍是旧文本，不能作判据）
  for (let k = 0; k < 80; k++) {
    await sleep(500)
    const now = await ev(`document.querySelector('#reflow-article')?.innerHTML.length ?? 0`)
    if (now !== prevLen && now > 2000) break
  }
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
  await sleep(1500)
  const title = await ev(`document.querySelector('#reader-title')?.textContent ?? ''`)
  const meta = await ev(`(() => {
    const art = document.querySelector('#reflow-article'); const out = []; let curPage = 0
    const walk = (el) => { for (const ch of el.children) {
      if (ch.classList.contains('page-sep')) { curPage = Number(ch.dataset.page) || curPage; continue }
      const imgs = ch.tagName === 'IMG' ? [ch] : [...ch.querySelectorAll('img')]
      if (imgs.length) { const isF = ch.classList.contains('formula'), isA = ch.classList.contains('algorithm'), isT = ch.classList.contains('table')
        for (const im of imgs) out.push({ kind: isF ? 'formula' : isA ? 'algo' : isT ? 'table' : 'figure', page: curPage, bi: ch.dataset.bi ?? '', text: (ch.querySelector('figcaption')?.textContent ?? ch.textContent ?? '').slice(0,100), natural: im.naturalWidth + 'x' + im.naturalHeight })
      }
      if (ch.children.length && !ch.matches('figure, .formula')) walk(ch)
    } }
    walk(art); return JSON.stringify(out)
  })()`)
  const items = JSON.parse(meta)
  const label = `b${b}`
  for (let i = 0; i < items.length; i++) {
    const src = await ev(`(() => { const im = [...document.querySelectorAll('#reflow-article img')][${i}]; return im ? im.src : '' })()`)
    const b64 = src && src.includes(',') ? src.split(',')[1] : ''
    const ext = src?.startsWith('data:image/jpeg') ? 'jpg' : 'png'
    const file = b64 ? `${label}-${String(i).padStart(2, '0')}-${items[i].kind}.${ext}` : ''
    if (b64) fs.writeFileSync(path.join(OUT, file), Buffer.from(b64, 'base64'))
    items[i].file = file
  }
  manifest.push({ book: b, title, items })
  console.log(`${label} ${title.slice(0, 40)}: ${items.length}`, JSON.stringify(items.map((x) => x.kind).reduce((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {})))
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1))
ws.close()
process.exit(0)
