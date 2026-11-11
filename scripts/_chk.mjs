import fs from 'node:fs'
import m from 'mupdf'
import { extractReflowBlocksMupdf } from '../src/renderer/src/reflow.ts'
const doc = m.Document.openDocument(new Uint8Array(fs.readFileSync(process.argv[2])), 'application/pdf')
const pages = []
for (let p = 0; p < doc.countPages(); p++) pages.push(doc.loadPage(p))
const blocks = await extractReflowBlocksMupdf(pages)
console.log('formula blocks:', blocks.filter(b=>b.kind==='formula').length)
blocks.filter(b=>b.kind==='formula' && b.page===5).forEach(b=>console.log(' p5', b.rect?.y0.toFixed(0), b.rect?.y1.toFixed(0), JSON.stringify(b.text.slice(0,40))))
