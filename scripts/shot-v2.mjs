/** 最终验证 + 成品截图：按标题选书，验证 H1 修复，截关键区域 */
import fs from 'node:fs'

const BASE = 'http://127.0.0.1:9222'
const OUT = 'C:/Users/admin/Desktop/逆向工程/paperlite/shots'
const KEY = process.argv[2] ?? 'Multiscale'

const targets = await (await fetch(`${BASE}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) { console.log('no page'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let seq = 0
const pending = new Map()
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
function send(method, params = {}) { return new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) }) }
const evalJs = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await send('Page.enable')

// 按卡片标题选书
await evalJs(`(async () => {
  for (let k = 0; k < 30; k++) { if (document.querySelectorAll('.book-card, .card').length > 0 || document.querySelectorAll('.open-btn').length > 0) break; await new Promise(r => setTimeout(r, 500)) }
  const cards = [...document.querySelectorAll('.open-btn')]
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i].closest('.card')
    if (card && card.textContent.includes('${KEY}')) { cards[i].click(); return 'opened:' + i }
  }
  return 'not-found'
})()`)

for (let k = 0; k < 40; k++) {
  await sleep(1000)
  const done = await evalJs(`(() => {
    const f = document.querySelectorAll('.formula').length
    const fi = document.querySelectorAll('.formula.formula-fidelity img').length
    const t = document.querySelectorAll('figure.table').length
    const ti = document.querySelectorAll('figure.table img').length
    return (f === 0 || fi === f) && (t === 0 || ti === t) && document.querySelectorAll('#reflow-article [data-bi]').length > 10 ? 'done' : 'pending'
  })()`)
  if (done === 'done') break
}
await sleep(1500)

// 验证：大字号行里不应再有续行散文
const bigLines = await evalJs(`(() => {
  const out = []
  for (const el of document.querySelectorAll('#reflow-article *')) {
    if (el.children.length > 0) continue
    const fs = parseFloat(getComputedStyle(el).fontSize)
    if (fs >= 19 && el.textContent.trim().length > 10) out.push(el.tagName + ':' + el.textContent.trim().slice(0, 50))
  }
  return JSON.stringify(out)
})()`)
console.log('大字号行:', bigLines)

const counts = await evalJs(`JSON.stringify({
  blocks: document.querySelectorAll('#reflow-article [data-bi]').length,
  formulas: document.querySelectorAll('.formula.formula-fidelity img').length,
  tables: document.querySelectorAll('figure.table img').length,
  algo: document.querySelectorAll('figure.table.algorithm img').length,
  refs: document.querySelectorAll('p.ref-entry').length
})`)
console.log('counts:', counts)

async function shot(name, scrollExpr, clip) {
  await evalJs(scrollExpr)
  await sleep(800)
  const r = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' })
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'))
  console.log('captured', name)
}

// 原 bug 区域（"and action" 那页，滚到公式 (2) 附近）
await shot('fix-whereq', `(() => { const els = [...document.querySelectorAll('#reflow-article p')].filter(p => /and action, respectively/i.test(p.textContent)); els[0]?.scrollIntoView({ block: 'center' }); return els.length })()`)
// 成品四连
await shot('final-overview', `(() => { document.querySelector('#reflow-wrap').scrollTop = 0; return 1 })()`)
await shot('final-algo', `(() => { document.querySelector('figure.table.algorithm')?.scrollIntoView({ block: 'start' }); return 1 })()`)
await shot('final-table', `(() => { const t = [...document.querySelectorAll('figure.table:not(.algorithm)')].find(f => f.querySelector('img')); t?.scrollIntoView({ block: 'center' }); return 1 })()`)
await shot('final-refs', `(() => { document.querySelector('p.ref-entry')?.scrollIntoView({ block: 'start' }); return 1 })()`)

ws.close()
process.exit(0)
