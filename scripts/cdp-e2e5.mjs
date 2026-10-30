/** 翻译缓存闭环 e2e v2：等排版就绪 → 译 → 入库 → 重开秒显 */
const BASE = 'http://127.0.0.1:9222'
const targets = await (await fetch(`${BASE}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) { console.log('no page'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let seq = 0
const pending = new Map()
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
function send(method, params = {}) { return new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) }) }
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitReady(timeoutMs = 40000) {
  for (let i = 0; i < timeoutMs / 1000; i++) {
    const n = await evalJs(`document.querySelectorAll('#reflow-article p[data-bi]').length`)
    if (n > 10) return true
    await sleep(1000)
  }
  return false
}

await sleep(2500)
const idx = await evalJs(`[...document.querySelectorAll('.card-title')].findIndex(t => t.textContent.includes('Trainable'))`)
const card = idx < 0 ? 0 : idx
console.log('[1] 打开论文（卡片', card, '），等待排版就绪…')
await evalJs(`document.querySelectorAll('.open-btn')[${card}].click()`)
if (!(await waitReady())) { console.log('✗ 排版未就绪'); process.exit(1) }
console.log('    排版就绪，点击「译」…')
await evalJs(`document.querySelector('#translate-btn').click()`)
let done = false
for (let i = 0; i < 40; i++) {
  await sleep(5000)
  done = await evalJs(`document.querySelector('#translate-btn').textContent === '已译'`)
  if (done) { console.log(`    翻译完成（约 ${i * 5 + 5}s）`); break }
}
const transCount = await evalJs(`document.querySelectorAll('p.trans').length`)
console.log('[2] 译文段数:', transCount)

await evalJs(`document.querySelector('#back-btn').click()`)
await sleep(1500)
console.log('[3] 重开论文…')
await evalJs(`document.querySelectorAll('.open-btn')[${card}].click()`)
if (!(await waitReady())) { console.log('✗ 重开排版未就绪'); process.exit(1) }
const auto = await evalJs(`JSON.stringify({
  transShown: document.querySelectorAll('#reflow-article.show-trans p.trans').length,
  btnText: document.querySelector('#translate-btn').textContent
})`)
console.log('[4] 重开后自动显示:', auto)
const j = JSON.parse(auto)
const pass = done && transCount > 50 && j.transShown > 50
console.log(pass ? '\n✓ 翻译→缓存→秒显 闭环通过' : '\n✗ 闭环有问题')
ws.close()
process.exit(pass ? 0 : 1)
