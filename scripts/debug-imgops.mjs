import { readFileSync } from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

// 用一篇有图的论文，看 paintImageXObject 算子的参数结构
const f = 'C:/Users/admin/Desktop/论文下载/downloads/2026-10-28/ieee/A Novel Multiscale Residual Active Deep Q-Learning Network for Intelli.pdf'
const task = getDocument({ data: new Uint8Array(readFileSync(f)) })
const doc = await task.promise
const page = await doc.getPage(3)
const ops = await page.getOperatorList()
const { OPS } = await import('pdfjs-dist')

let imgCount = 0
for (let i = 0; i < ops.fnArray.length; i++) {
  const fn = ops.fnArray[i]
  const name = Object.entries(OPS).find(([k, v]) => v === fn)?.[0]
  if (name && /paint.*(Image|Jpeg|Inline)/.test(name) && imgCount < 4) {
    imgCount++
    console.log(name, '→ args:', JSON.stringify(ops.argsArray[i]).slice(0, 140))
  }
  // 也看图片前后的 transform，了解坐标系
  if (name === 'transform' && imgCount > 0 && imgCount < 3 && i < ops.fnArray.length) {
    // 只打印紧跟图片后的前几个
  }
}
console.log('图片算子总数(第3页):', ops.fnArray.filter((f) => f === OPS.paintImageXObject || f === OPS.paintJpegXObject || f === OPS.paintInlineImageXObject).length)
console.log('OPS 常量:', { paintImageXObject: OPS.paintImageXObject, paintJpeg: OPS.paintJpegXObject, paintInline: OPS.paintInlineImageXObject })
await task.destroy()
