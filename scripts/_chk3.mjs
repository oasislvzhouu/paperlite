import fs from 'node:fs'
import m from 'mupdf'
import { extractReflowBlocksMupdf } from '../src/renderer/src/reflow.ts'
const doc = m.Document.openDocument(new Uint8Array(fs.readFileSync(process.argv[2])), 'application/pdf')
const pages = []
for (let p = 0; p < doc.countPages(); p++) pages.push(doc.loadPage(p))
const blocks = await extractReflowBlocksMupdf(pages)
blocks.forEach((b, i) => {
  if (b.page === 3 && b.rect && b.rect.x1 - b.rect.x0 > 380) {
    console.log(`#${i} ${b.kind} y[${b.rect.y0.toFixed(0)},${b.rect.y1.toFixed(0)}] x[${b.rect.x0.toFixed(0)},${b.rect.x1.toFixed(0)}] text=${JSON.stringify(b.text.slice(0,80))}`)
  }
})
