/** 验收：原子块可选中文字 / 字体跟随原文 / 跨页标记 */
import fs from 'node:fs'
const BASE='http://127.0.0.1:9222'
const OUT='C:/Users/admin/Desktop/逆向工程/paperlite/shots-43'
fs.mkdirSync(OUT,{recursive:true})
const t=await(await fetch(`${BASE}/json`)).json()
const page=t.find(x=>x.type==='page'&&x.webSocketDebuggerUrl)
const ws=new WebSocket(page.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r)
let seq=0;const pend=new Map()
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id)}}
const send=(m,pa={})=>new Promise(r=>{const id=++seq;pend.set(id,r);ws.send(JSON.stringify({id,method:m,params:pa}))})
const ev=async x=>(await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true})).result?.result?.value
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const shoot=async n=>{const r=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(`${OUT}/${n}.png`,Buffer.from(r.result.data,'base64'));console.log('shot',n)}
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false})
await ev(`(async()=>{for(let k=0;k<60;k++){if(document.querySelectorAll('.open-btn').length){document.querySelector('.open-btn').click();return 1}await new Promise(r=>setTimeout(r,400))}return 0})()`)
for(let k=0;k<60;k++){await sleep(1000);const n=await ev(`document.querySelectorAll('#reflow-article [data-bi]').length`);if(n>10)break}
await sleep(4000)

// 1) 原子块：覆盖层与文本
console.log('atomic:', await ev(`JSON.stringify((() => {
  const figs=[...document.querySelectorAll('#reflow-article figure.table')]
  const f=figs.find(x=>x.querySelector('.atomic-text'))
  if(!f) return {found:false, figs:figs.length}
  const spans=[...f.querySelectorAll('.atomic-text span')]
  const img=f.querySelector('.atomic img')
  const r=f.getBoundingClientRect()
  return {found:true, spans:spans.length, sample:spans.slice(0,3).map(s=>s.textContent.slice(0,30)), imgW: img?Math.round(img.getBoundingClientRect().width):0, figW:Math.round(r.width), cqw: getComputedStyle(spans[0]).fontSize}
})())`))

// 2) 选中覆盖层文字（Range 选择）并读 selected text
console.log('select:', await ev(`(() => {
  const f=[...document.querySelectorAll('#reflow-article figure.table')].find(x=>x.querySelector('.atomic-text'))
  const spans=[...f.querySelectorAll('.atomic-text span')]
  const r=document.createRange()
  const a=spans[0].firstChild, b=spans[Math.min(2,spans.length-1)].firstChild
  r.setStart(a,0); r.setEnd(b, b.length)
  const sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(r)
  return JSON.stringify({text: sel.toString().slice(0,60)})
})()`))
await sleep(300); await shoot('atomic-select')

// 3) 字体跟随：统计 ff-sans/ff-mono 数量与计算字体
console.log('fonts:', await ev(`JSON.stringify({
  sans: document.querySelectorAll('#reflow-article .ff-sans').length,
  mono: document.querySelectorAll('#reflow-article .ff-mono').length,
  follow: document.querySelector('#reflow-article').dataset.followFont,
  sansFamily: (()=>{const e=document.querySelector('#reflow-article .ff-sans'); return e?getComputedStyle(e).fontFamily.slice(0,40):null})()
})`))

// 4) 跨页标记
const crossCount = await ev(`document.querySelectorAll('#reflow-article p.cross-page, #reflow-article p.cross-col').length`)
console.log('cross blocks:', crossCount)
await ev(`document.querySelectorAll('#rs-cross button').forEach(b=>{if(b.dataset.v==='on')b.click()})`)
await sleep(400)
await ev(`(() => { const p=document.querySelector('#reflow-article p.cross-page'); p?.scrollIntoView({block:'center'}); return 1 })()`)
await sleep(600); await shoot('cross-mark')
await ev(`document.querySelectorAll('#rs-cross button').forEach(b=>{if(b.dataset.v==='off')b.click()})`)
ws.close();process.exit(0)
