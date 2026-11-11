import fs from 'node:fs'
import m from 'mupdf'
const doc = m.Document.openDocument(new Uint8Array(fs.readFileSync(process.argv[2])), 'application/pdf')
const st = JSON.parse(doc.loadPage(4).toStructuredText().asJSON())
const types = {}
for (const b of st.blocks) types[b.type] = (types[b.type] ?? 0) + 1
console.log('block types:', types)
for (const b of st.blocks) {
  if (b.type !== 'text') console.log(JSON.stringify({ type: b.type, bbox: b.bbox }))
}
