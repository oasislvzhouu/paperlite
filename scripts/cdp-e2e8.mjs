/** e2e #8：三类新块验证 —— 算法框原子化 + MuPDF 表格裁图 + 参考文献区
 * 用法：先启动 npm start -- --remote-debugging-port=9222，再 node scripts/cdp-e2e8.mjs [书索引=0] */
const BASE = 'http://127.0.0.1:9222'
const bookIdx = Number(process.argv[2] ?? 0)

const targets = await (await fetch(`${BASE}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) { console.log('no page'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let seq = 0
const pending = new Map()
const errors = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description?.slice(0, 200) ?? 'exception')
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args?.[0]?.value?.slice?.(0, 200) ?? 'console.error')
}
function send(method, params = {}) { return new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) }) }
const evalJs = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 打开指定书 → 重排构建（轮询等待书架就绪 + 重排完成）
const btnCount = await evalJs(`(async () => {
  for (let k = 0; k < 30; k++) {
    const n = document.querySelectorAll('.open-btn').length
    if (n > ${bookIdx}) return n
    await new Promise((r) => setTimeout(r, 500))
  }
  return document.querySelectorAll('.open-btn').length
})()`)
console.log('[书架] open-btn 数量:', btnCount)
await evalJs(`document.querySelectorAll('.open-btn')[${bookIdx}]?.click()`)
for (let k = 0; k < 30; k++) {
  await sleep(1000)
  const ready = await evalJs(`document.querySelectorAll('#reflow-article [data-bi]').length`)
  if (Number(ready) > 5) break
}
await sleep(4000)

const state = await evalJs(`(() => {
  const algo = [...document.querySelectorAll('figure.table.algorithm')]
  const tbls = [...document.querySelectorAll('figure.table')]
  const refEntries = [...document.querySelectorAll('p.ref-entry')]
  const refSample = refEntries[0]?.textContent?.slice(0, 80) ?? null
  return JSON.stringify({
    reflowMode: document.body.classList.contains('reflow-mode'),
    paras: document.querySelectorAll('#reflow-article p[data-bi]').length,
    formulas: document.querySelectorAll('.formula').length,
    formulasImg: document.querySelectorAll('.formula.formula-fidelity img').length,
    tables: tbls.length,
    tablesImg: tbls.filter(f => f.querySelector('img')).length,
    algoBlocks: algo.length,
    algoImg: algo.filter(f => f.querySelector('img')).length,
    algoCaption: algo.map(f => f.querySelector('figcaption')?.textContent?.slice(0, 50)),
    refEntries: refEntries.length,
    refSample,
    imgBytes: [...document.querySelectorAll('figure.table img')].map(i => i.src.length).reduce((a, b) => a + b, 0)
  })
})()`)
console.log('[状态]', state)

// 表格裁图数据源验证：img 应为 data:image/jpeg（MuPDF 管线），且非空
const imgProbe = await evalJs(`(() => {
  const i = document.querySelector('figure.table img')
  return i ? (i.src.startsWith('data:image/jpeg') ? 'jpeg-ok:' + i.src.length : 'bad:' + i.src.slice(0, 30)) : 'none'
})()`)
console.log('[表格图]', imgProbe)

// 翻译计数应不含 ref-entry：对比 article 内可译段落数
const transProbe = await evalJs(`(() => {
  const all = document.querySelectorAll('#reflow-article p[data-bi]').length
  const refs = document.querySelectorAll('p.ref-entry').length
  return JSON.stringify({ totalParas: all, refExcluded: refs })
})()`)
console.log('[翻译排除]', transProbe)

console.log('[渲染异常]', errors.length === 0 ? '无' : errors.slice(0, 5))
ws.close()
process.exit(0)
