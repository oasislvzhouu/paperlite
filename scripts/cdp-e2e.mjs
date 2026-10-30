/** UI 端到端探针：程序化点击 打开/返回书架，验证界面状态机真实工作 */
const BASE = 'http://127.0.0.1:9222'
const targets = await (await fetch(`${BASE}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) { console.log('no page target'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let seq = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
const send = (method, params = {}) =>
  new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) return 'EXC: ' + (r.result.exceptionDetails.exception?.description ?? '').slice(0, 300)
  return r.result?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const state = () => evalJs(`JSON.stringify({
  headerHidden: document.querySelector('#shelf-header').hidden,
  shelfHidden: document.querySelector('#shelf').hidden,
  readerHidden: document.querySelector('#reader').hidden,
  emptyTipVisible: !document.querySelector('#empty-tip').hidden,
  cards: document.querySelectorAll('.card').length,
  title: document.querySelector('#reader-title').textContent,
  pageTotal: document.querySelector('#page-total').textContent,
  articleBlocks: document.querySelectorAll('#reflow-article > *').length,
  bodyMode: document.body.className
})`)

console.log('[1] 启动后的书架状态:', await state())
if (await evalJs(`document.querySelectorAll('.card').length`) === 0) {
  console.log('!! 书架为空，中止'); ws.close(); process.exit(1)
}

console.log('[2] 点击第一张卡片的「打开」...')
await evalJs(`document.querySelector('.open-btn').click()`)
await sleep(4000)
console.log('[3] 阅读器状态:', await state())

console.log('[4] 点击「← 书架」...')
await evalJs(`document.querySelector('#back-btn').click()`)
await sleep(1500)
console.log('[5] 返回后的书架状态:', await state())

console.log('[6] 再次打开 → 切到原版模式...')
await evalJs(`document.querySelectorAll('.open-btn')[0].click()`)
await sleep(3500)
await evalJs(`document.querySelector('#original-btn').click()`)
await sleep(1500)
const st = await state()
console.log('[7] 原版模式状态:', st)
const ok = JSON.parse(st)
const pass = !ok.headerHidden === false && ok.readerHidden === false && ok.pageTotal !== '?'
console.log(pass ? '\n✓ UI 状态机工作正常' : '\n✗ 仍有问题')
ws.close()
process.exit(pass ? 0 : 1)
