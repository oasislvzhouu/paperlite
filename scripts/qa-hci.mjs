/** 验收：悬浮工具条 / AI 解释入口 / 论文信息弹窗 / 目标语言下拉 */
import fs from 'node:fs'

const BASE = 'http://127.0.0.1:9222'
const OUT = 'C:/Users/admin/Desktop/逆向工程/paperlite/shots-hci'
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
await sleep(3000)

// 1) 悬浮工具条：hover 公式块
console.log('tools:', await ev(`(async () => {
  const f = document.querySelector('#reflow-article .formula')
  if (!f) return 'no-formula'
  f.scrollIntoView({ block: 'center' })
  f.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
  await new Promise(r => setTimeout(r, 400))
  const bar = f.querySelector('.media-tools')
  return JSON.stringify({ decorated: !!bar, buttons: bar ? [...bar.querySelectorAll('button')].map(b => b.dataset.act) : [] })
})()`))
await sleep(400)
await ev(`(() => { const f=document.querySelector('#reflow-article .formula.has-media-tools'); f?.classList.add('hover-demo'); const bar=f?.querySelector('.media-tools'); if(bar){bar.style.opacity='1'; bar.style.pointerEvents='auto'} return 1 })()`)
await shoot('media-tools')

// 2) AI 解释按钮（无 API Key 时应显示错误而不是崩溃）
console.log('explain:', await ev(`(async () => {
  const f = document.querySelector('#reflow-article .formula.has-media-tools')
  const btn = f?.querySelector('.media-tools button[data-act="explain"]')
  if (!btn) return 'no-btn'
  btn.click()
  await new Promise(r => setTimeout(r, 1500))
  const pop = document.querySelector('#explain-pop')
  return JSON.stringify({ open: !pop.hidden, text: (document.querySelector('#explain-body').textContent || '').slice(0, 80) })
})()`))
await sleep(400)
await shoot('explain-pop')
await ev(`document.querySelector('#explain-close').click()`)

// 3) 论文信息弹窗
console.log('info:', await ev(`(async () => {
  document.querySelector('#info-btn').click()
  await new Promise(r => setTimeout(r, 500))
  const pop = document.querySelector('#info-pop')
  return JSON.stringify({ open: !pop.hidden, body: (document.querySelector('#info-body').textContent || '').replace(/\\s+/g, ' ').slice(0, 160) })
})()`))
await sleep(400)
await shoot('info-pop')
// BibTeX 内容
console.log('bibtex:', await ev(`(async () => {
  let copied = ''
  const orig = navigator.clipboard.writeText.bind(navigator.clipboard)
  navigator.clipboard.writeText = async (t) => { copied = t; return orig(t).catch(() => {}) }
  document.querySelector('#copy-bibtex').click()
  await new Promise(r => setTimeout(r, 500))
  return JSON.stringify({ copied: copied.split(String.fromCharCode(10)).slice(0, 3) })
})()`))
await ev(`document.querySelector('#info-close').click()`)

// 4) 目标语言下拉
console.log('lang:', await ev(`(async () => {
  const sel = document.querySelector('#rs-lang')
  sel.value = 'ja'; sel.dispatchEvent(new Event('change'))
  await new Promise(r => setTimeout(r, 300))
  return JSON.stringify({ value: sel.value, stored: JSON.parse(localStorage.getItem('pl.read.settings.v1') || '{}').lang })
})()`))
await ev(`(() => { const sel=document.querySelector('#rs-lang'); sel.value='zh-CN'; sel.dispatchEvent(new Event('change')); return 1 })()`)

ws.close()
process.exit(0)
