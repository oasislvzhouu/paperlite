import fs from 'node:fs'
const BASE='http://127.0.0.1:9222'
const OUT='C:/Users/admin/Desktop/逆向工程/paperlite/cmp'
const KEY=process.argv[2]??'sound-vibration'
const t=await(await fetch(`${BASE}/json`)).json()
const page=t.find(x=>x.type==='page'&&x.webSocketDebuggerUrl)
const ws=new WebSocket(page.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r)
let seq=0;const pend=new Map()
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id)}}
const send=(m,pa={})=>new Promise(r=>{const id=++seq;pend.set(id,r);ws.send(JSON.stringify({id,method:m,params:pa}))})
const ev=async x=>(await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true})).result?.result?.value
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride',{width:900,height:1500,deviceScaleFactor:1,mobile:false})
await ev(`(async()=>{for(let k=0;k<60;k++){const cards=[...document.querySelectorAll('.card')];const c=cards.find(x=>x.querySelector('.card-title')?.textContent.toLowerCase().includes(${JSON.stringify(KEY.toLowerCase())}));if(c){c.querySelector('.open-btn').click();return 1}await new Promise(r=>setTimeout(r,400))}return 0})()`)
for(let k=0;k<60;k++){await sleep(1000);const n=await ev(`document.querySelectorAll('#reflow-article [data-bi]').length`);if(n>10)break}
await sleep(4000)
await ev(`(() => {
  const a=document.querySelector('#reflow-article')
  a.style.setProperty('--reflow-width','760px')
  document.querySelectorAll('#rs-para button').forEach(b=>{if(b.dataset.v==='academic')b.click()})
  document.querySelectorAll('#rs-theme button').forEach(b=>{if(b.dataset.v==='light')b.click()})
  const size=document.querySelector('#rs-size'); size.value='16'; size.dispatchEvent(new Event('input'))
  const lh=document.querySelector('#rs-lh'); lh.value='1.5'; lh.dispatchEvent(new Event('input'))
  return 1
})()`)
await sleep(900)
const shoot=async(name,pageNo)=>{
  await ev(`(() => { const w=document.querySelector('#reflow-wrap'); if(${pageNo}===1){w.scrollTop=0;return 1} const sep=[...document.querySelectorAll('#reflow-wrap .page-sep')].find(s=>s.dataset.page==='${pageNo}'); if(sep) w.scrollTop=sep.offsetTop-8; return 1 })()`)
  await sleep(200)
  await ev(`document.querySelector('#reflow-article').classList.remove('show-trans')`)
  await sleep(400)
  const r=await send('Page.captureScreenshot',{format:'png'})
  fs.writeFileSync(`${OUT}/${name}.png`,Buffer.from(r.result.data,'base64'))
  console.log('shot',name)
}
await shoot('ours2-p1',1)
await shoot('ours2-p2',2)
ws.close();process.exit(0)
