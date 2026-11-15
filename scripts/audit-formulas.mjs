import fs from 'node:fs'
import m from 'mupdf'
import { extractReflowBlocksMupdf } from '../src/renderer/src/reflow.ts'
const doc = m.Document.openDocument(new Uint8Array(fs.readFileSync(process.argv[2])), 'application/pdf')
const pages = []
for (let p = 0; p < doc.countPages(); p++) pages.push(doc.loadPage(p))
const blocks = await extractReflowBlocksMupdf(pages)
const fx = blocks.filter(b=>b.kind==='formula')
console.log('总块', blocks.length, '公式', fx.length, 'geo', fx.filter(b=>b.geo).length)
fx.forEach((b,i)=>console.log(` ${b.geo?'G':'x'} p${b.page} y[${b.rect?.y0.toFixed(0)},${b.rect?.y1.toFixed(0)}] h=${b.rect? (b.rect.y1-b.rect.y0).toFixed(0):'?'} x[${b.rect?.x0.toFixed(0)},${b.rect?.x1.toFixed(0)}] | ${b.text.replace(/\s+/g,' ').slice(0,60)}`))
