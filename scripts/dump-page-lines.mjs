/** 打印指定页的行（含位置/词数），定位裁图边界误判 */
import fs from 'node:fs'
import m from 'mupdf'

const src = process.argv[2]
const pagesArg = (process.argv[3] ?? '4').split(',').map(Number)
const doc = m.Document.openDocument(new Uint8Array(fs.readFileSync(src)), 'application/pdf')
for (const p of pagesArg) {
  const pg = doc.loadPage(p - 1)
  const st = JSON.parse(pg.toStructuredText().asJSON())
  console.log('=== page', p)
  for (const b of st.blocks) for (const l of b.lines ?? []) {
    const t = (l.text ?? '').replace(/\s+/g, ' ').trim()
    if (!t) continue
    const bb = l.bbox
    const wc = t.split(/\s+/).filter(Boolean).length
    console.log(`y=${bb.y.toFixed(0)} x=[${bb.x.toFixed(0)},${(bb.x + bb.w).toFixed(0)}] h=${bb.h.toFixed(1)} w=${wc} | ${t.slice(0, 78)}`)
  }
}
