import { readFileSync } from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractReflowBlocks } from '../src/renderer/src/reflow.ts'
const data = new Uint8Array(readFileSync(new URL('./fixtures/reflow-test.pdf', import.meta.url)))
const doc = await getDocument({ data }).promise
const blocks = await extractReflowBlocks(doc)
console.log('env:', process.env.REFLOW_DEBUG)
console.log(JSON.stringify(blocks.map(b => [b.kind, b.page, b.text]), null, 1))
