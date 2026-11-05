p = r'C:\Users\admin\Desktop\逆向工程\paperlite\src\renderer\src\reader.ts'
s = open(p, encoding='utf-8').read()

anchor = "/* ── 整页视觉 LLM 解析：后台逐页 → 结构化块替换 ── */"
assert anchor in s, 'anchor missing'

block = r'''/* ── 公式原版面裁图渲染（对标 Scholaread no-reflow-formula 策略） ──
 * 逆向结论：其渲染层用 no-reflow-formula / no-reflow-image / no-reflow-table
 * 等原子块直接呈现原始 PDF 字形，不做文本重建；MathJax 仅用于 AI 回答。
 * 我们采用同一策略：按公式块 rect 从 MuPDF 页面裁图插入，保真度 100%。 */

const formulaPageCanvas = new Map<number, HTMLCanvasElement>()

async function getPageCanvasMupdf(pageNo: number, scale = 3): Promise<HTMLCanvasElement | null> {
  const hit = formulaPageCanvas.get(pageNo)
  if (hit) return hit
  if (!mupdfDocRef) return null
  const m = await loadMupdf().catch(() => null)
  if (!m) return null
  try {
    const page = mupdfDocRef.loadPage(pageNo - 1)
    const pixmap = page.toPixmap(m.Matrix.scale(scale, scale), m.ColorSpace.DeviceRGB)
    const png: Uint8Array = pixmap.asPNG()
    const blob = new Blob([new Uint8Array(png)], { type: 'image/png' })
    const bmp = await createImageBitmap(blob)
    const cv = document.createElement('canvas')
    cv.width = bmp.width
    cv.height = bmp.height
    const cx = cv.getContext('2d')
    if (!cx) return null
    cx.drawImage(bmp, 0, 0)
    formulaPageCanvas.set(pageNo, cv)
    return cv
  } catch {
    return null
  }
}

/** 像素级自适应裁边：在公式行带内扫描暗像素求真实左右边界
 *  （分数/根式/上下标远超行框宽度，固定 padding 必切内容） */
async function renderFormulasAsImages(): Promise<void> {
  const blocksNow = blocks
  if (!blocksNow || !mupdfDocRef) return
  const scale = 3
  for (let bi = 0; bi < blocksNow.length; bi++) {
    const b = blocksNow[bi]
    if (b.kind !== 'formula' || !b.rect) continue
    const el = document.querySelector<HTMLElement>(`.formula[data-bi="${bi}"]`)
    if (!el || el.dataset['imgDone'] === '1') continue
    const canvas = await getPageCanvasMupdf(b.page, scale)
    if (!canvas) continue
    const pageW = canvas.width / scale
    const bandY0 = Math.max(0, Math.floor((b.rect.y0 - 6) * scale))
    const bandY1 = Math.min(canvas.height, Math.ceil((b.rect.y1 + 6) * scale))
    const bandH = Math.max(1, bandY1 - bandY0)
    const bandW = canvas.width
    const tmp = document.createElement('canvas')
    tmp.width = bandW
    tmp.height = bandH
    const tctx = tmp.getContext('2d', { willReadFrequently: true })
    if (!tctx) continue
    tctx.fillStyle = '#fff'
    tctx.fillRect(0, 0, bandW, bandH)
    tctx.drawImage(canvas, 0, bandY0, bandW, bandH, 0, 0, bandW, bandH)
    const data = tctx.getImageData(0, 0, bandW, bandH).data
    const colMid = pageW / 2
    const looksRightCol = b.rect.x0 > colMid + 5
    const looksLeftCol = b.rect.x1 < colMid - 5
    const scanX0 = Math.floor((looksRightCol ? colMid + 5 : 10) * scale)
    const scanX1 = Math.min(bandW - 1, Math.floor((looksLeftCol ? colMid - 5 : pageW - 10) * scale))
    let minX = Number.POSITIVE_INFINITY
    let maxX = -1
    for (let py = 0; py < bandH; py++) {
      const rowOff = py * bandW * 4
      for (let px = scanX0; px <= scanX1; px++) {
        const o = rowOff + px * 4
        if (data[o] < 200 || data[o + 1] < 200 || data[o + 2] < 200) {
          if (px < minX) minX = px
          if (px > maxX) maxX = px
        }
      }
    }
    if (!Number.isFinite(minX) || maxX < 0 || maxX <= minX) continue
    const pad = 6
    const cx0 = Math.max(0, minX - pad)
    const cx1 = Math.min(bandW, maxX + pad)
    const out = document.createElement('canvas')
    out.width = Math.max(1, cx1 - cx0)
    out.height = bandH
    const octx = out.getContext('2d')
    if (!octx) continue
    octx.fillStyle = '#fff'
    octx.fillRect(0, 0, out.width, out.height)
    octx.drawImage(canvas, cx0, bandY0, cx1 - cx0, bandH, 0, 0, out.width, out.height)
    const img = document.createElement('img')
    img.src = out.toDataURL('image/png')
    img.className = 'formula-img'
    img.alt = b.text.slice(0, 40)
    el.innerHTML = ''
    el.appendChild(img)
    el.classList.add('formula-fidelity')
    el.dataset['imgDone'] = '1'
  }
}

'''

s = s.replace(anchor, block + anchor)

# 接入 mode 分支：公式裁图优先，LLM 队列不再默认抢跑
old_call = "    // 整页视觉 LLM 公式提取（MuPDF 渲染，无 pdf.js 泄洪依赖）\n    void parseAllPages()"
new_call = "    // 公式保真裁图优先（对标 no-reflow-formula）；LLM→KaTeX 作为可选增强\n    window.setTimeout(() => {\n      if (readingId === id && mode === 'reflow') void renderFormulasAsImages()\n    }, 600)"
assert old_call in s, 'call site not found'
s = s.replace(old_call, new_call)

# 打开新文档清缓存
s = s.replace("  pageCanvasCache.clear()", "  pageCanvasCache.clear()\n  formulaPageCanvas.clear()")

open(p, 'w', encoding='utf-8').write(s)
print('formula image rendering re-added')
