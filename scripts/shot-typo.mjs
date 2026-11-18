import fs from 'node:fs'
const BASE='http://127.0.0.1:9222'
const OUT='C:/Users/admin/Desktop/逆向工程/paperlite/shots-typo'
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
await sleep(2500)
await ev(`(() => { const h=[...document.querySelectorAll('#reflow-article h2')].find(x=>/INTRODUCTION|RELATED/i.test(x.textContent)); (h||document.querySelector('#reflow-article h2'))?.scrollIntoView({block:'start'}); return 1 })()`)
await sleep(600)

// 学术预设（默认）
await shoot('academic')
// 中文预设
await ev(`document.querySelectorAll('#rs-para button').forEach(b=>{if(b.dataset.v==='cjk')b.click()})`)
await sleep(500); await shoot('cjk')
await ev(`document.querySelectorAll('#rs-para button').forEach(b=>{if(b.dataset.v==='academic')b.click()})`)

// 统计：富文本标签、标题字号
console.log(await ev(`JSON.stringify({
  bold: document.querySelectorAll('#reflow-article p b, #reflow-article h1 b, #reflow-article h2 b').length,
  italic: document.querySelectorAll('#reflow-article i').length,
  h2size: [...document.querySelectorAll('#reflow-article h2')].slice(0,3).map(h=>getComputedStyle(h).fontSize),
  bodyIndent: getComputedStyle(document.querySelector('#reflow-article p')).textIndent,
  align: getComputedStyle(document.querySelector('#reflow-article p')).textAlign
})`))
ws.close();process.exit(0)
