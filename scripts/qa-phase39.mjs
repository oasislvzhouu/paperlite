/** 验收：字体切换 / 引用反向高亮 / 侧栏标签与筛选与联动 */
import fs from 'node:fs'

const BASE = 'http://127.0.0.1:9222'
const OUT = 'C:/Users/admin/Desktop/逆向工程/paperlite/shots-final'
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

// ── 1) 字体：切到 Linux Libertine，确认字体族生效
console.log('font:', await ev(`(async () => {
  const sel = document.querySelector('#rs-font')
  sel.value = 'libertine'; sel.dispatchEvent(new Event('change'))
  await new Promise(r => setTimeout(r, 600))
  const cs = getComputedStyle(document.querySelector('#reflow-article'))
  return JSON.stringify({ family: cs.fontFamily.slice(0, 60), loaded: document.fonts.check('16px "Linux Libertine"') })
})()`))
await ev(`(() => { const p=document.querySelector('#reflow-article p[data-bi]'); p?.scrollIntoView({block:'center'}); return 1 })()`)
await sleep(500); await shoot('font-libertine')

// ── 2) 引用反向高亮：点参考文献条目 → 正文所有 [n] 高亮
console.log('reverse:', await ev(`(async () => {
  const entry = [...document.querySelectorAll('p.ref-entry')].find(p => /\\[\\d+\\]/.test(p.textContent))
  if (!entry) return 'no-ref'
  const n = (entry.textContent.match(/\\[(\\d{1,3})\\]/) || [])[1]
  entry.scrollIntoView({ block: 'center' })
  entry.click()
  await new Promise(r => setTimeout(r, 800))
  const hits = [...document.querySelectorAll('a.cite.cite-hit')]
  return JSON.stringify({ n, hits: hits.length, firstVisible: !!hits[0] })
})()`))
await sleep(600); await shoot('reverse-cite')

// ── 3) 侧栏：造 3 条高亮（2 带笔记 + 不同颜色），验证标签/筛选/联动
console.log('seed:', await ev(`(async () => {
  const ps = [...document.querySelectorAll('#reflow-article p[data-bi]')].filter(p => !p.classList.contains('ref-entry') && p.textContent.trim().length > 100)
  const textNode = (p) => { const w=document.createTreeWalker(p, NodeFilter.SHOW_TEXT); let n=null, best=null; while((n=w.nextNode())){ if(!best || n.data.length>best.data.length) best=n } return best }
  const mk = (p, a, b) => { const tn=textNode(p); const r=document.createRange(); r.setStart(tn,a); r.setEnd(tn,Math.min(b, tn.data.length)); const s=window.getSelection(); s.removeAllRanges(); s.addRange(r); p.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})) }
  const add = async (p, a, b, color, note) => {
    mk(p, a, b); await new Promise(r=>setTimeout(r,350))
    // 彩色高亮必须走笔记弹窗（快捷「高亮」按钮固定黄色）
    const useEditor = !!note || color !== 'yellow'
    const btn = document.querySelector('#hl-pop button[data-act="' + (useEditor ? 'note' : 'hl') + '"]')
    if (!btn) return false
    btn.click(); await new Promise(r=>setTimeout(r,300))
    if (useEditor) {
      const sw = document.querySelector('#note-pop .swatch[data-color="' + color + '"]')
      sw?.click()
      document.querySelector('#note-text').value = note || ''
      document.querySelector('#note-save').click()
    }
    await new Promise(r=>setTimeout(r,800))
    return true
  }
  const r1 = await add(ps[0], 3, 38, 'yellow', '批注一：方法有效性存疑，需核对第 3 节公式推导')
  const r2 = await add(ps[1], 4, 40, 'green', '批注二：这组准确率与表 4 一致')
  const r3 = await add(ps[2], 5, 36, 'blue', '')
  return JSON.stringify({ r1, r2, r3, marks: document.querySelectorAll('#reflow-article mark.hl').length })
})()`))
await ev(`document.querySelector('#notes-btn').click()`)
await sleep(700)
console.log('panel:', await ev(`JSON.stringify({ items: document.querySelectorAll('#notes-list .note-item').length, all: document.querySelector('#cnt-all').textContent, note: document.querySelector('#cnt-note').textContent, hl: document.querySelector('#cnt-hl').textContent })`))
await shoot('panel-all')

// 批注标签
await ev(`document.querySelector('.notes-tabs button[data-tab="note"]').click()`)
await sleep(400)
console.log('tab-note:', await ev(`JSON.stringify({ items: document.querySelectorAll('#notes-list .note-item').length, hasNotes: document.querySelectorAll('#notes-list .note-text').length })`))
await shoot('panel-note-tab')

// 颜色筛选：蓝
await ev(`document.querySelector('.notes-tabs button[data-tab="all"]').click()`)
await ev(`document.querySelector('.notes-colors button[data-color="blue"]').click()`)
await sleep(400)
console.log('filter-blue:', await ev(`JSON.stringify({ items: document.querySelectorAll('#notes-list .note-item').length })`))
await ev(`document.querySelector('.notes-colors button[data-color="all"]').click()`)

// 正文 → 侧栏联动：点最后一个高亮
console.log('link:', await ev(`(async () => {
  const marks = [...document.querySelectorAll('#reflow-article mark.hl')]
  marks[marks.length-1].click()
  await new Promise(r => setTimeout(r, 600))
  const act = document.querySelector('#notes-list .note-item.active')
  return JSON.stringify({ active: !!act, hid: act ? act.dataset.hid : null })
})()`))
await shoot('panel-link')
ws.close()
process.exit(0)
