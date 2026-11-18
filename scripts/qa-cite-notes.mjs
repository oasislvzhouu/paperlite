/** 验收：引用角标跳转 + 笔记侧栏（走真实 UI 流程） */
import fs from 'node:fs'

const BASE = 'http://127.0.0.1:9222'
const OUT = 'C:/Users/admin/Desktop/逆向工程/paperlite/shots-notes'
fs.mkdirSync(OUT, { recursive: true })

const t = await (await fetch(`${BASE}/json`)).json()
const page = t.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
if (!page) { console.log('no page'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let seq = 0
const pend = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shoot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${OUT}/${n}.png`, Buffer.from(r.result.data, 'base64')); console.log('shot', n) }

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })

await ev(`(async () => { for (let k=0;k<60;k++){ if(document.querySelectorAll('.open-btn').length){document.querySelector('.open-btn').click(); return 1} await new Promise(r=>setTimeout(r,400)) } return 0 })()`)
for (let k = 0; k < 60; k++) { await sleep(1000); const n = await ev(`document.querySelectorAll('#reflow-article [data-bi]').length`); if (n > 10) break }
await sleep(2500)

// 1) 引用角标
console.log('cites:', await ev(`JSON.stringify({ total: document.querySelectorAll('#reflow-article a.cite').length, sample: [...document.querySelectorAll('#reflow-article a.cite')].slice(0,5).map(a=>a.textContent) })`))

// 2) 点击可匹配的引用 → 跳转 + 闪烁
console.log('jump:', await ev(`(async () => {
  const a = [...document.querySelectorAll('#reflow-article a.cite')].find(x => {
    const n = x.dataset.cite
    return [...document.querySelectorAll('p.ref-entry')].some(p => (p.textContent||'').trimStart().startsWith('[' + n + ']'))
  })
  if (!a) return 'no-matchable-cite'
  a.scrollIntoView({ block: 'center' }); a.click()
  await new Promise(r => setTimeout(r, 800))
  const f = document.querySelector('#reflow-article .ref-flash')
  return JSON.stringify({ cite: a.textContent, flashed: !!f, target: f ? f.textContent.slice(0, 36) : null })
})()`))
await sleep(300); await shoot('cite-jump')

// 3) 通过真实选区流程建两条高亮（第二条带笔记）
const hl = await ev(`(async () => {
  const ps = [...document.querySelectorAll('#reflow-article p[data-bi]')].filter(p => !p.classList.contains('ref-entry') && p.textContent.trim().length > 90)
  if (ps.length < 2) return 'no-paras'
  const mk = (p, a, b) => {
    const r = document.createRange()
    r.setStart(p.firstChild, a); r.setEnd(p.firstChild, b)
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r)
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  }
  mk(ps[0], 5, 45)
  await new Promise(r => setTimeout(r, 350))
  document.querySelector('#hl-pop button[data-act="hl"]').click()
  await new Promise(r => setTimeout(r, 700))
  mk(ps[1], 6, 52)
  await new Promise(r => setTimeout(r, 350))
  document.querySelector('#hl-pop button[data-act="note"]').click()
  await new Promise(r => setTimeout(r, 300))
  document.querySelector('#note-text').value = '测试笔记：这条批注用于验收侧栏'
  document.querySelector('#note-save').click()
  await new Promise(r => setTimeout(r, 900))
  return JSON.stringify({ marks: document.querySelectorAll('#reflow-article mark.hl').length, badge: document.querySelector('#notes-count')?.textContent })
})()`)
console.log('highlights:', hl)

// 4) 打开侧栏
await ev(`document.querySelector('#notes-btn').click()`)
await sleep(700)
console.log('sidebar:', await ev(`JSON.stringify({ items: document.querySelectorAll('#notes-list .note-item').length, hasNote: !!document.querySelector('#notes-list .note-text'), squeeze: document.querySelector('#reader').classList.contains('notes-open') })`))
await shoot('notes-panel')

// 5) 点击侧栏条目 → 高亮闪烁
console.log('flash:', await ev(`(async () => {
  document.querySelector('#notes-list .note-item').click()
  await new Promise(r => setTimeout(r, 500))
  return JSON.stringify({ flashed: !!document.querySelector('#reflow-article mark.hl.hl-flash') })
})()`))
ws.close()
process.exit(0)
