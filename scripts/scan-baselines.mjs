/** 静态基线扫描：三篇库内 PDF 的算法框/表注/参考文献标题计数（预测运行时块数） */
import m from 'mupdf'
import fs from 'node:fs'
import path from 'node:path'

const dir = path.join(process.env.APPDATA, 'paperlite', 'library')
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.pdf')) continue
  const doc = m.Document.openDocument(new Uint8Array(fs.readFileSync(path.join(dir, f))), 'application/pdf')
  let algo = 0, tbl = 0, refsHead = 0
  const pages = doc.countPages()
  for (let p = 0; p < pages; p++) {
    const st = JSON.parse(doc.loadPage(p).toStructuredText().asJSON())
    const lines = st.blocks
      .flatMap((b) => b.lines ?? [])
      .map((l) => (l.text || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    for (const t of lines) {
      if (/^algorithm\s*(\d{1,3}|[IVXLC]{1,6})\s*[:.·\-—–]?/i.test(t)) algo++
      if (/^(table|表)\s*([IVXLC]{1,6}|\d+)\b/i.test(t)) tbl++
      if (/^(references?|bibliography|参考文献)\s*$/i.test(t)) refsHead++
    }
  }
  console.log(f.slice(0, 8), 'pages=' + pages, 'algoCaptions=' + algo, 'tblCaptions=' + tbl, 'refsHeading=' + refsHead)
  doc.destroy()
}
