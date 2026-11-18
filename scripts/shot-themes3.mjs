import fs from 'node:fs'
const BASE='http://127.0.0.1:9222'
const OUT='C:/Users/admin/Desktop/逆向工程/paperlite/shots-theme'
const t=await(await fetch(`${BASE}/json`)).json()
const page=t.find(x=>x.type==='page'&&x.webSocketDebuggerUrl)
const ws=new WebSocket(page.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r)
let seq=0;const pend=new Map()
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id)}}
const send=(method,params={})=>new Promise(r=>{const id=++seq;pend.set(id,r);ws.send(JSON.stringify({id,method,params}))})
const ev=async x=>(await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true})).result?.result?.value
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false})

await ev(`(async () => {
  for (let k=0;k<60;k++){ if(document.querySelectorAll('.open-btn').length){document.querySelector('.open-btn').click(); return 1} await new Promise(r=>setTimeout(r,400)) }
  return 0
})()`)
for (let k=0;k<50;k++){ await sleep(1000); const n=await ev(`document.querySelectorAll('#reflow-article [data-bi]').length`); if(n>10) break }
await sleep(2500)
const shoot=async n=>{const r=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(`${OUT}/${n}.png`,Buffer.from(r.result.data,'base64'));console.log('shot',n)}

await ev(`document.querySelectorAll('#rs-theme button').forEach(b=>{if(b.dataset.v==='dark')b.click()})`)
await ev(`(() => { const f=document.querySelector('#reflow-article .formula'); f?.scrollIntoView({block:'center'}); return !!f })()`)
await sleep(900); await shoot('dark-formula-fixed')

// 开译文并切换到下划线
await ev(`(() => { const a=document.querySelector('#reflow-article'); if(!a.classList.contains('show-trans')) document.querySelector('#translate-btn').click(); return a.className })()`)
await sleep(1500)
await ev(`document.querySelectorAll('#rs-trans button').forEach(b=>{if(b.dataset.v==='underline')b.click()})`)
await ev(`(() => { const t=document.querySelector('#reflow-article p.trans'); t?.scrollIntoView({block:'center'}); return !!t })()`)
await sleep(900); await shoot('trans-underline3')
const vis=await ev(`(() => { const t=document.querySelector('#reflow-article p.trans'); if(!t) return 'none'; const cs=getComputedStyle(t); return JSON.stringify({display:cs.display, deco:cs.textDecorationLine, style:cs.textDecorationStyle, offset:cs.textUnderlineOffset}) })()`)
console.log('trans style:', vis)
ws.close(); process.exit(0)
