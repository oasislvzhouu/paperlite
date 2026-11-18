/**
 * 把 Scholaread 的转换产物（server/N/index.html + index.css）拼成可渲染的
 * 独立页面，用于和 PaperLite 逐页对比。
 * 用法：node scripts/build-scholaread-page.mjs <hash> <page> <out.html> [width]
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(
  process.env.APPDATA ?? '',
  'scholaread',
  'files',
  'out'
)

const hash = process.argv[2]
const page = process.argv[3] ?? '1'
const outp = process.argv[4] ?? 'scholaread-page.html'
const width = Number(process.argv[5] ?? 760)

// 找到该 hash 的 server 目录（跨引擎版本）
let serverDir = null
for (const v of fs.readdirSync(ROOT)) {
  const cand = path.join(ROOT, v, hash, 'server')
  if (fs.existsSync(path.join(cand, page, 'index.html'))) {
    serverDir = cand
    break
  }
}
if (!serverDir) {
  console.error('server dir not found for', hash)
  process.exit(1)
}

const dir = path.join(serverDir, page)
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
const css = fs.readFileSync(path.join(dir, 'index.css'), 'utf8')

// 阅读层最小复刻（对照 index-9602fedb.css 的关键规则）
const readerCss = `
:root{--client-width:${width}px;--reader-font-size:1;--reader-font-family:inherit}
html,body{margin:0;padding:0;background:#fff;color:#121212}
body{font-family:Georgia,'Times New Roman',serif}
#wrap{width:${width}px;margin:0 auto;padding:20px 15px;box-sizing:border-box}
.pf{width:100%}
.pdf_paragraph{margin-top:1.5em;line-height:1.4}
.pdf_paragraph_separator{height:1.5em;display:none}
.pdf_paragraph.pdf_heading{margin-top:1.2em}
.pdf_paragraph b,.pdf_paragraph strong{font-weight:700}
.pdf_intro{color:#666;line-height:1.3}
.no-reflow-table,.no-reflow-image,.no-reflow-formula,.no-reflow-author{margin-top:16px}
.no-reflow-table,.no-reflow-image{background:#fff}
.no-reflow-formula{padding:6px 0 8px;height:calc(var(--region-h) * var(--region-scale) * 1px);background:#fafafa;border-radius:4px;
  --region-r:calc(var(--region-w)/var(--region-h));--region-scale:calc(var(--formula-w)/var(--region-w));--formula-w:min(var(--region-w),500px)}
.no-reflow-formula .formula-container{position:relative;left:50%;width:calc(var(--region-w)*1px);aspect-ratio:var(--region-r);transform:scale(var(--region-scale)) translate(-50%)}
.no-reflow-formula,.no-reflow-table,.no-reflow-image{cursor:zoom-in}
`

const full = `<!doctype html><html><head><meta charset="utf-8">
<style>${readerCss}</style>
<style>${css}</style>
</head><body><div id="wrap">${html}</div></body></html>`

fs.writeFileSync(outp, full, 'utf8')
console.log('written', outp, 'css', css.length, 'html', html.length)
