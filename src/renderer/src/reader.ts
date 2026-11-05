import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { extractReflowBlocks, extractReflowBlocksMupdf, cropPageImages, type MupdfPageLike, type ReflowBlock } from './reflow'
import { applyHighlights, initHighlightEvents, loadHighlights } from './highlights'
import { recreatePdfWorker } from './worker-mgr'
import { isPollutedLatex } from './llm-shared'

type Mode = 'reflow' | 'original'

/** 版面宽度三档（对齐原版可调宽度），localStorage 持久化 */
const WIDTHS = [
  { em: 42, label: '窄' },
  { em: 56, label: '宽' },
  { em: 72, label: '超宽' }
]
// 启动默认「超宽」（对齐原版），会话内可临时切换
let widthIdx = WIDTHS.length - 1

function applyWidth(): void {
  const w = WIDTHS[widthIdx]
  $('#reflow-article').style.setProperty('--reflow-width', `${w.em}em`)
  const btn = $('#width-btn')
  btn.textContent = w.label
  btn.title = `版面宽度：${w.label}（${w.em}em，点击切换）`
}

interface TocEntry {
  title: string
  page: number
  level: number
  /** 由标题块生成的条目：跳转到对应元素 */
  bi?: number
}
let toc: TocEntry[] = []

async function loadOutline(d: PDFDocumentProxy): Promise<TocEntry[]> {
  const out: TocEntry[] = []
  const walk = async (items: Array<{ title?: string; dest?: unknown; items?: unknown[] }>, level: number): Promise<void> => {
    for (const it of items) {
      let page = 0
      try {
        if (it.dest) {
          const dest = typeof it.dest === 'string' ? await d.getDestination(it.dest) : it.dest
          if (Array.isArray(dest) && dest[0] != null) {
            const idx = typeof dest[0] === 'object'
            ? await d.getPageIndex(dest[0] as Parameters<typeof d.getPageIndex>[0])
            : (dest[0] as number)
            page = idx + 1
          }
        }
      } catch {
        /* 单个书签解析失败忽略 */
      }
      out.push({ title: it.title ?? '', page, level })
      if (Array.isArray(it.items) && it.items.length > 0) await walk(it.items as never, level + 1)
    }
  }
  let items: Array<{ title?: string; dest?: unknown; items?: unknown[] }> = []
  try {
    items = (await d.getOutline()) ?? []
  } catch {
    items = []
  }
  await walk(items, 1)
  if (out.length === 0 && blocks) {
    // PDF 无内嵌书签 → 用重排引擎识别的标题生成目录
    blocks.forEach((b, bi) => {
      if (b.kind === 'heading' && b.text.trim().length > 1) {
        out.push({ title: b.text, page: b.page, level: clamp(b.level ?? 2, 1, 3), bi })
      }
    })
  }
  return out
}

function renderToc(): void {
  const list = $('#toc-list')
  if (toc.length === 0) {
    list.innerHTML = '<div style="padding:14px;color:var(--muted);font-size:13px;">此 PDF 没有内嵌书签目录</div>'
    return
  }
  const esc = (s: string): string =>
    s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
  list.innerHTML = toc
    .map(
      (t, i) =>
        `<button class="toc-item l${clamp(t.level, 1, 3)}" data-i="${i}">${esc(t.title)}<span class="toc-pg">${t.page || ''}</span></button>`
    )
    .join('')
}

let doc: PDFDocumentProxy | null = null
let task: pdfjsLib.PDFDocumentLoadingTask | null = null
let readingId = 0
let pageNum = 1
let zoom = 1
let fitWidth = true
let saveTimer: number | undefined
let scrollTimer: number | undefined

let mode: Mode = 'reflow'
let blocks: ReflowBlock[] | null = null
let mupdfBlocks: ReflowBlock[] | null = null
let llmPageBlocks = new Map<number, ReflowBlock[]>()
let mupdfDocRef: { loadPage: (n: number) => { toPixmap: (m: unknown, c: unknown) => { asPNG: () => Uint8Array } } } | null = null
/* eslint-disable @typescript-eslint/no-explicit-any */
let mupdfModuleRef: any = null
/** MuPDF 模块：动态导入包装模块（独立 chunk，避免顶层 await 阻塞主图） */
async function loadMupdf(): Promise<any> {
  if (mupdfModuleRef) return mupdfModuleRef
  const mod: any = await import('./mupdf-loader')
  const m = mod.mupdf ?? mod.default ?? mod
  if (!m || typeof m.Document?.openDocument !== 'function') {
    const keys = Object.keys(mod ?? {}).join(',')
    throw new Error(`mupdf-loader 未导出可用模块（keys: ${keys}）`)
  }
  mupdfModuleRef = m
  return m
}
let llmParsing = new Set<number>()


let reflowFont = 17

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )
}

export async function openReader(id: number): Promise<void> {
  const info = await window.paperlite.openReading(id)
  if (!info) return
  await task?.destroy()
  const load = (): void => {
    task = pdfjsLib.getDocument({
      url: window.paperlite.pdfUrl(id),
      cMapUrl: 'assets/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'assets/standard_fonts/',
      isOffscreenCanvasSupported: false,
    disableFontFace: true
    })
  }
  load()
  doc = await task!.promise
  // 会话级 worker 随机坏死检测：渲染探测失败 → 重建 worker 重载文档（最多 2 轮）
  for (let attempt = 0; attempt < 1 && !(await quickRenderProbe()); attempt++) {
    await task!.destroy()
    recreatePdfWorker()
    load()
    doc = await task!.promise
  }
  readingId = id
  pageNum = clamp(info.lastPage || 1, 1, doc.numPages)
  zoom = 1
  pageCanvasCache.clear()
  formulaPageCanvas.clear()
  llmPageBlocks.clear()
  llmParsing.clear()
  $('#reader-title').textContent = info.title
  $('#page-total').textContent = String(doc.numPages)
  $('#shelf').hidden = true
  $('#shelf-header').hidden = true
  $('#empty-tip').hidden = true
  $('#reader').hidden = false

  // 解析重排：MuPDF 原生行分组优先（行质量远高于 pdf.js 碎片文本），
  // 失败时回退 pdf.js 文本管线；大文件解析给加载提示
  $('#reflow-loading').hidden = false
  try {
    const res = await fetch(window.paperlite.pdfUrl(id))
    const buf = new Uint8Array(await res.arrayBuffer())
    const mupdfMod = await loadMupdf()
    const mupdfDoc = mupdfMod.Document.openDocument(buf, 'application/pdf')
    mupdfDocRef = mupdfDoc as unknown as NonNullable<typeof mupdfDocRef>
    const mupdfPages: MupdfPageLike[] = []
    for (let p = 0; p < mupdfDoc.countPages(); p++) {
      mupdfPages.push(mupdfDoc.loadPage(p) as unknown as MupdfPageLike)
    }
    blocks = await extractReflowBlocksMupdf(mupdfPages)
  } catch (err) {
    console.warn('[paperlite] MuPDF 提取失败，回退 pdf.js 管线', err)
    try {
      blocks = await extractReflowBlocks(doc)
    } catch {
      blocks = null
    }
  }
  mupdfBlocks = blocks
  if (!blocks || blocks.length === 0) blocks = null
  $('#reflow-loading').hidden = true

  if (blocks && blocks.length > 0) {
    mode = 'reflow'
  } else {
    mode = 'original'
    blocks = null
    $('#reflow-article').innerHTML =
      '<p class="reflow-notice">此 PDF 没有可提取的文字层（可能是扫描件），已切换到原版模式。OCR 支持在路线图后续阶段。</p>'
  }
  applyMode()
  if (mode === 'reflow') {
    renderReflow()
    applyWidth()
    goTo(pageNum)
    void loadHighlights(id).then(() => applyHighlights())
    void hydrateTranslations()
    // 公式保真裁图优先（对标 no-reflow-formula）；LLM→KaTeX 作为可选增强
    window.setTimeout(() => {
      if (readingId === id && mode === 'reflow') void renderFormulasAsImages()
    }, 600)
    // 表格原子块（MuPDF 裁图）与公式同源，紧跟其后（不依赖 pdf.js render 状态）
    window.setTimeout(() => {
      if (readingId === id && mode === 'reflow') void attachTables()
    }, 1000)
    // render 恢复窗口：图片管线独立探测恢复（平台级泄洪期可达分钟级）
    window.setTimeout(() => {
      if (readingId === id && mode === 'reflow') void attachImages()
    }, 8000)
    // 旧逐公式 LLM 路径已由 parseAllPages（整页批量）取代，不再调度——
    // 两条路径都会改写 .formula 内容，并行会产生污染叠加
  } else {
    applyWidth()
    pdfScrollBuilt = false
    await buildPdfScroll()
    goTo(pageNum)
  }
  toc = await loadOutline(doc)
  renderToc()
  void window.paperlite.saveProgress(id, pageNum, doc.numPages)
}

export function closeReader(): void {
  $('#reader').hidden = true
  $('#shelf').hidden = false
  $('#shelf-header').hidden = false
}

/* ── 模式切换 ─────────────────────────────── */

function applyMode(): void {
  document.body.classList.toggle('reflow-mode', mode === 'reflow')
  $('#reflow-btn').classList.toggle('toggle-on', mode === 'reflow')
  $('#original-btn').classList.toggle('toggle-on', mode === 'original')
  $('#reflow-wrap').hidden = mode !== 'reflow'
  $('#page-wrap').hidden = mode !== 'original'
}

/* ── 排版模式 ─────────────────────────────── */

/** 记录每个块在 blocks 中的下标，用于翻译对位 */
function renderReflow(): void {
  if (!blocks) return
  const article = $('#reflow-article')
  const parts: string[] = []
  let lastPage = 0
  blocks.forEach((b, bi) => {
    if (b.page !== lastPage) {
      parts.push(`<div class="page-sep" data-page="${b.page}">第 ${b.page} 页</div>`)
      lastPage = b.page
    }
    const body = b.html ?? escapeHtml(b.text)
    if (b.kind === 'formula') {
      parts.push(`<div class="formula" data-bi="${bi}">${body}</div>`)
    } else if (b.kind === 'image') {
      const imgs = (b.images ?? [])
        .map((src) => `<img src="${src}" alt="figure" loading="lazy" />`)
        .join('')
      parts.push(`<figure class="figure" data-bi="${bi}">${imgs}</figure>`)
    } else if (b.kind === 'table') {
      const algoCls = b.role === 'algorithm' ? ' algorithm' : ''
      parts.push(
        `<figure class="figure table${algoCls}" data-bi="${bi}"><figcaption>${body}</figcaption></figure>`
      )
    } else if (b.kind === 'heading') {
      const lvl = clamp(b.level ?? 3, 1, 4)
      const roleCls = b.role ? ` ${b.role}` : ''
      parts.push(`<h${lvl} class="${roleCls.trim()}" data-bi="${bi}">${body}</h${lvl}>`)
    } else {
      const roleCls = b.role ? ` ${b.role}` : ''
      parts.push(`<p class="${roleCls.trim()}" data-bi="${bi}">${body}</p>`)
    }
  })
  article.innerHTML = parts.join('\n')
  article.style.setProperty('--reflow-font', `${reflowFont}px`)
  article.classList.remove('show-trans', 'has-trans')
}

/** 渐进图片挂载：文本渲染后逐页补图（单页 4s 护栏，失败不影响阅读） */
function insertFigure(pageNo: number, yTop: number, dataUrl: string, naturalRatio = 1): void {
  const article = $('#reflow-article')
  if (!blocks) return
  const key = `${pageNo}-${Math.round(yTop)}`
  if (article.querySelector(`figure[data-key="${key}"]`)) return
  const fig = document.createElement('figure')
  fig.className = 'figure'
  fig.dataset['key'] = key
  const img = document.createElement('img')
  img.src = dataUrl
  // 按自然尺寸占比展示：小图不拉满（下限 42% 保可读，上限 100%）
  const pct = Math.round(Math.min(100, Math.max(42, naturalRatio * 115)))
  img.style.maxWidth = pct + '%'
  fig.appendChild(img)
  // 插到同页第一个 top >= 图片顶的块之前；没有则放页尾（下一页分隔符前）
  const anchor = blocks
    .map((b, bi) => ({ b, bi }))
    .find((x) => x.b.page === pageNo && x.b.top !== undefined && x.b.top >= yTop)
  const anchorEl = anchor ? article.querySelector(`[data-bi="${anchor.bi}"]`) : null
  if (anchorEl?.parentNode) {
    anchorEl.parentNode.insertBefore(fig, anchorEl)
  } else {
    const nextSep = article.querySelector(`.page-sep[data-page="${pageNo + 1}"]`)
    if (nextSep) article.insertBefore(fig, nextSep)
    else article.appendChild(fig)
  }
}

/** 单次快速渲染探测（3s），用于判断本 worker 是否具备渲染能力 */
async function quickRenderProbe(): Promise<boolean> {
  if (!doc) return false
  try {
    const page = await doc.getPage(1)
    const vp = page.getViewport({ scale: 0.25 })
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.floor(vp.width))
    c.height = Math.max(1, Math.floor(vp.height))
    const cx = c.getContext('2d')
    if (!cx) return false
    await Promise.race([
      page.render({ canvasContext: cx, viewport: vp }).promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('probe-timeout')), 3000))
    ])
    return true
  } catch {
    const g = globalThis as { __plProbe?: number[] }
    g.__plProbe = [...(g.__plProbe ?? []), Math.round(performance.now())]
    return false
  }
}

/** 泄洪/毒化规避探测：低分辨率试渲染，3s 内响应即就绪。
 *  注意：绝不调用 renderTask.cancel()——cancel 会毒化 pdf.js v4 的 intentState，
 *  使该页（乃至后续）所有 render 永久挂起；超时直接丢弃任务引用即可 */
async function probeRenderReady(): Promise<boolean> {
  if (!doc) return false
  try {
    const page = await doc.getPage(1)
    for (let i = 0; i < 8; i++) {
      try {
        const vp = page.getViewport({ scale: 0.25 })
        const c = document.createElement('canvas')
        c.width = Math.max(1, Math.floor(vp.width))
        c.height = Math.max(1, Math.floor(vp.height))
        const cx = c.getContext('2d')
        if (!cx) return false
        await Promise.race([
          page.render({ canvasContext: cx, viewport: vp }).promise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('probe-timeout')), 3000))
        ])
        return true
      } catch {
        const g = globalThis as { __plProbe?: number[] }
        g.__plProbe = [...(g.__plProbe ?? []), Math.round(performance.now())]
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
  } catch {
    /* ignore */
  }
  return false
}

function showRenderDownTip(): void {
  const g = globalThis as { __plRenderTipShown?: boolean }
  if (g.__plRenderTipShown) return
  g.__plRenderTipShown = true
  const chip = document.querySelector('#trans-status') as HTMLElement | null
  const text = document.querySelector('#trans-status-text') as HTMLElement | null
  if (!chip || !text) return
  text.textContent = '本会话图表渲染未就绪，重启应用可恢复'
  chip.classList.remove('done')
  chip.hidden = false
  window.setTimeout(() => {
    chip.classList.add('done')
    window.setTimeout(() => (chip.hidden = true), 450)
  }, 4000)
}

async function attachImages(): Promise<void> {
  if (!doc || mode !== 'reflow') return
  if (!(await probeRenderReady())) {
    showRenderDownTip()
    return
  }
  let inserted = 0
  for (let p = 1; p <= doc.numPages; p++) {
    if (readingId === 0) return
    try {
      const page = await doc.getPage(p)
      const vp = page.getViewport({ scale: 1 })
      const imgs = await Promise.race([
        cropPageImages(page, vp.width, vp.height, pdfjsLib.OPS),
        new Promise<Array<{ yTop: number; x0: number; x1: number; image?: string }>>((resolve) =>
          setTimeout(() => resolve([]), 15000)
        )
      ])
      for (const im of imgs) {
        if (im.image) {
          const ratio = vp.width > 0 ? (im.x1 - im.x0) / vp.width : 1
          insertFigure(p, im.yTop, im.image, ratio)
          inserted++
        }
      }
    } catch {
      /* 单页失败跳过 */
    }
  }
  // 提示用户图表已就位（复用右下角浮标）
  if (inserted > 0) {
    const chip = document.querySelector('#trans-status') as HTMLElement | null
    const text = document.querySelector('#trans-status-text') as HTMLElement | null
    if (chip && text) {
      text.textContent = `图表加载完成 ✓ ${inserted} 张`
      chip.classList.remove('done')
      chip.hidden = false
      window.setTimeout(() => {
        chip.classList.add('done')
        window.setTimeout(() => (chip.hidden = true), 450)
      }, 2000)
    }
  }
}

/** 表格块渲染：MuPDF 整块矩形裁图（含转曲矢量表格）
 * 对标 Scholaread no-reflow-table 原子块：不走 pdf.js render（其会话级死亡时表格全灭），
 * 与公式管线共用 MuPDF 3× 页面画布缓存（同页公式已渲染则零额外开销）。 */
async function attachTables(): Promise<void> {
  if (!blocks || mode !== 'reflow') return
  for (const b of blocks) {
    if (b.kind !== 'table' || !b.rect || readingId === 0) continue
    try {
      const target = document.querySelector(`figure.table[data-bi="${blocks.indexOf(b)}"]`)
      if (!target || target.querySelector('img')) continue
      const canvas = await getPageCanvasMupdf(b.page, 3)
      if (!canvas) continue
      const scale = 3
      const pad = 4
      const x = Math.max(0, Math.floor((b.rect.x0 - pad) * scale))
      const y = Math.max(0, Math.floor((b.rect.y0 - pad) * scale))
      const w = Math.min(canvas.width - x, Math.ceil((b.rect.x1 - b.rect.x0 + pad * 2) * scale))
      const h = Math.min(canvas.height - y, Math.ceil((b.rect.y1 - b.rect.y0 + pad * 2) * scale))
      if (w < 20 || h < 20) continue
      const out = document.createElement('canvas')
      out.width = w
      out.height = h
      const octx = out.getContext('2d')
      if (!octx) continue
      octx.fillStyle = '#fff'
      octx.fillRect(0, 0, out.width, out.height)
      octx.drawImage(canvas, x, y, w, h, 0, 0, out.width, out.height)
      const img = document.createElement('img')
      img.src = out.toDataURL('image/jpeg', 0.92)
      img.style.maxWidth = '100%'
      target.appendChild(img)
    } catch {
      /* 单表失败跳过 */
    }
  }
}

/* ── 公式原版面裁图渲染（对标 Scholaread no-reflow-formula 策略） ──
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

/* ── 整页视觉 LLM 解析：后台逐页 → 结构化块替换 ── */

let pageParseSeq = 0

async function renderPageToDataUrl(p: number): Promise<string | null> {
  if (!mupdfDocRef) return null
  const m = await loadMupdf().catch(() => null)
  if (!m) return null
  try {
    const page = mupdfDocRef.loadPage(p - 1)
    const pixmap = page.toPixmap(m.Matrix.scale(2, 2), m.ColorSpace.DeviceRGB)
    const png = pixmap.asPNG()
    let binary = ''
    for (let i = 0; i < png.length; i += 8192) {
      binary += String.fromCharCode(...png.subarray(i, i + 8192))
    }
    return 'data:image/png;base64,' + btoa(binary)
  } catch (err) {
    console.warn('[paperlite] MuPDF 页面渲染失败 p=' + p, err)
    return null
  }
}

/** 用 LaTeX 列表回填 formula 块（KaTeX 渲染，失败保留文本） */
function applyFormulaLatex(latexList: string[]): void {
  const blocksNow = blocks ?? []
  const fBlocks = blocksNow.filter((b) => b.kind === 'formula')
  const fEls = [...document.querySelectorAll('.formula')]
  let k = 0
  for (const fb of fBlocks) {
    const latex = latexList[k]
    k++
    if (!latex) continue
    fb.latex = latex
    fb.text = latex
    let html: string
    try {
      html = katex.renderToString(latex, { displayMode: true, throwOnError: true, strict: false })
    } catch {
      html = ''
    }
    const idx = blocksNow.indexOf(fb)
    const el = fEls.length === fBlocks.length ? fEls[idx] : null
    if (el && html) {
      el.innerHTML = html
      el.classList.add('katex-ok')
      el.setAttribute('title', `LaTeX: ${latex}`)
    }
  }
}

/** 后台逐页：整页图 → LLM 提取该页公式 LaTeX → 按 formula 块顺序回填 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function parseAllPages(): Promise<void> {
  const blocksNow = blocks
  if (!doc || !blocksNow) return
  const rid = readingId
  const pages = Array.from({ length: doc.numPages }, (_, k) => k + 1)
  const total = pages.length
  let done = 0
  const chipText = (): HTMLElement => document.querySelector('#trans-status-text') as HTMLElement
  const chip = (): HTMLElement => document.querySelector('#trans-status') as HTMLElement
  const showChip = (txt: string): void => {
    const c = chip()
    if (c && chipText()) {
      c.classList.remove('done')
      c.hidden = false
      chipText().textContent = txt
    }
  }
  const status = await window.paperlite.llmStatus()
  if (!status.hasKey) return

  const queue = [...pages]
  const attempts = new Map<number, number>()
  const worker = async (): Promise<void> => {
    while (queue.length > 0 && doc && readingId === rid) {
      const p = queue.shift()
      if (p === undefined) return
      try {
        const page = await doc.getPage(p)
        const vp = page.getViewport({ scale: 1 })
        // 该页的公式块（编号行的 zone 或独立公式块）
        const fBlocks = blocksNow.filter((b) => b.page === p && b.kind === 'formula')
        if (fBlocks.length === 0) continue
        // 页面渲染（MuPDF toPixmap，无 pdf.js worker 依赖）
        const dataUrl = mupdfModuleRef
          ? await renderPageToDataUrl(p)
          : await renderPageToDataUrl(p)
        if (!dataUrl) {
          attempts.set(p, (attempts.get(p) ?? 0) + 1)
          if ((attempts.get(p) ?? 0) < 3) queue.push(p)
          await sleep(6000)
          continue
        }
        const latexList = JSON.parse(await window.paperlite.pageParseParse(dataUrl)) as string[]
        if (!Array.isArray(latexList) || latexList.length === 0) continue
        // 配对策略：数量相等→按序直配（最可靠）；数量不等→变量重叠度匹配，
        // 相似度不足则跳过该块（避免错位渲染出错误公式）
        const assign: Array<string | null> = fBlocks.map(() => null)
        if (latexList.length === fBlocks.length) {
          latexList.forEach((lx, k) => (assign[k] = lx))
        } else {
          const varTokens = (txt: string): Set<string> =>
            new Set((txt.match(/[A-Za-z][A-Za-z0-9]{0,6}/g) ?? []).map((t) => t.toLowerCase()))
          const used = new Set<number>()
          fBlocks.forEach((b, bi) => {
            const bVars = varTokens(b.text)
            let best = -1
            let bestScore = 0
            latexList.forEach((lx, li) => {
              if (used.has(li)) return
              const lVars = varTokens(lx)
              let hit = 0
              for (const v of bVars) if (lVars.has(v)) hit++
              const score = bVars.size > 0 ? hit / bVars.size : 0
              if (score > bestScore) {
                bestScore = score
                best = li
              }
            })
            // 置信门槛：变量重叠 ≥40% 才采用
            if (best >= 0 && bestScore >= 0.4) {
              assign[bi] = latexList[best]
              used.add(best)
            }
          })
        }
        let n = 0
        for (const b of fBlocks) {
          const latex = assign[n]
          n++
          if (!latex) continue
          // 污染检测：LLM 把周边正文（≥3 个 4 字母英文词）写进 LaTeX → 跳过该条，
          // 保留块原有文本形式（宁朴素不错乱）
          if (isPollutedLatex(latex)) continue
          b.latex = latex
          b.text = latex
          let html: string
          try {
            html = katex.renderToString(latex, { displayMode: true, throwOnError: true, strict: false })
          } catch {
            continue
          }
          b.html = html
          const el = document.querySelector(`.formula[data-bi="${blocksNow.indexOf(b)}"]`)
          if (el) {
            el.innerHTML = html
            el.classList.add('katex-ok')
            el.setAttribute('title', `LaTeX: ${latex}`)
          }
        }
        done++
        showChip(`AI 公式识别 ${done}/${total} 页`)
      } catch (err) {
        console.warn('[paperlite] 页面公式识别失败（跳过）p=', err)
      }
    }
  }
  await Promise.all([worker(), worker()])
  if (doc && readingId === rid) {
    const c = chip()
    if (c && chipText()) {
      chipText().textContent = `AI 公式识别完成 ✓ ${total} 页`
      c.classList.remove('done')
      c.hidden = false
      window.setTimeout(() => {
        c.classList.add('done')
        window.setTimeout(() => (c.hidden = true), 500)
      }, 1800)
    }
  }
}


/* ── 公式 LaTeX 升级：裁源图 → LLM 视觉识别 → KaTeX 渲染 ── */

interface FRect {
  x0: number
  x1: number
  y0: number
  y1: number
}

const pageCanvasCache = new Map<number, HTMLCanvasElement>()
const FORMULA_SCALE = 2.5

async function cropFormula(pageNo: number, rect: FRect): Promise<string | null> {
  if (!doc) return null
  const page = await doc.getPage(pageNo)
  let canvas = pageCanvasCache.get(pageNo)
  if (!canvas) {
    const viewport = page.getViewport({ scale: FORMULA_SCALE })
    canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    const c = canvas.getContext('2d')
    if (!c) return null
    await page.render({ canvasContext: c, viewport }).promise
    pageCanvasCache.set(pageNo, canvas)
  }
  const pad = 4
  const x = Math.max(0, (rect.x0 - pad) * FORMULA_SCALE)
  const y = Math.max(0, (rect.y0 - pad) * FORMULA_SCALE)
  const w = Math.min(canvas.width - x, (rect.x1 - rect.x0 + pad * 2) * FORMULA_SCALE)
  const h = Math.min(canvas.height - y, (rect.y1 - rect.y0 + pad * 2) * FORMULA_SCALE)
  if (w < 12 || h < 12 || w > 1600 || h > 800) return null
  const out = document.createElement('canvas')
  out.width = Math.floor(w)
  out.height = Math.floor(h)
  const octx = out.getContext('2d')
  if (!octx) return null
  octx.fillStyle = '#fff'
  octx.fillRect(0, 0, out.width, out.height)
  octx.drawImage(canvas, x, y, w, h, 0, 0, out.width, out.height)
  return out.toDataURL('image/jpeg', 0.92)
}

/** 相邻公式块（同页、垂直间距 < 20pt）合并为一个识别区域，避免孤儿上下标碎片被单独识别 */
async function upgradeFormulas(): Promise<void> {
  if (!blocks || !doc) return
  await probeRenderReady()
  try {
    const status = await window.paperlite.llmStatus()
    if (!status.hasKey) return
  } catch {
    return
  }

  const groups: Array<{ first: number; els: number[]; page: number; rect: FRect }> = []
  blocks.forEach((b, bi) => {
    if (b.kind !== 'formula' || !b.rect) return
    const r: FRect = b.rect
    const g = groups[groups.length - 1]
    if (g && g.page === b.page && r.y0 - g.rect.y1 < 20 && r.y0 >= g.rect.y0) {
      g.rect = {
        x0: Math.min(g.rect.x0, r.x0),
        x1: Math.max(g.rect.x1, r.x1),
        y0: Math.min(g.rect.y0, r.y0),
        y1: Math.max(g.rect.y1, r.y1)
      }
      g.els.push(bi)
    } else {
      groups.push({ first: bi, els: [bi], page: b.page, rect: { ...r } })
    }
  })

  const queue = [...groups]
  const worker = async (): Promise<void> => {
    for (;;) {
      const g = queue.shift()
      if (!g) return
      try {
        const dataUrl = await cropFormula(g.page, g.rect)
        if (!dataUrl) continue
        const latex = await window.paperlite.recognizeFormula(dataUrl)
        if (!latex || latex.length > 1500 || latex.includes('无法') || latex.includes('不是公式')) {
          continue
        }
        const el = document.querySelector<HTMLElement>(`.formula[data-bi="${g.first}"]`)
        if (!el) continue
        // 先试渲染，成功才替换；失败保留原有 sub/sup 文本形式（不显示红色源码）
        let html: string
        try {
          html = katex.renderToString(latex, { displayMode: true, throwOnError: true, strict: false })
        } catch {
          continue
        }
        el.innerHTML = html
        el.classList.add('katex-ok')
        el.setAttribute('title', `LaTeX: ${latex}`)
        for (const bi of g.els.slice(1)) {
          document.querySelector(`.formula[data-bi="${bi}"]`)?.setAttribute('style', 'display:none')
        }
      } catch (err) {
        console.warn('[paperlite] 公式识别失败（保留文本形式）', err)
      }
    }
  }
  await Promise.all([worker(), worker(), worker()])
}

/** 在指定段落后插入译文（按块下标定位），幂等 */
function insertTrans(bi: number, trans: string): void {
  const article = $('#reflow-article')
  const el = article.querySelector<HTMLParagraphElement>(`p[data-bi="${bi}"]`)
  if (!el || el.nextElementSibling?.classList.contains('trans')) return
  const t = document.createElement('p')
  t.className = 'trans'
  t.textContent = trans
  el.after(t)
}

function paragraphIndexes(): Array<{ bi: number; text: string }> {
  if (!blocks) return []
  return blocks
    .map((b, bi) => ({ b, bi }))
    // 参考文献条目不译（对标 no_trans）：引用串翻译无意义且烧配额
    .filter((x) => x.b.kind === 'paragraph' && x.b.role !== 'ref-entry')
    .map((x) => ({ bi: x.bi, text: x.b.text }))
}

/** 打开文档后：只从本地缓存恢复译文（无网络请求，秒显） */
async function hydrateTranslations(): Promise<void> {
  const paras = paragraphIndexes()
  if (paras.length === 0) return
  try {
    const cached = await window.paperlite.translationsGet(paras.map((p) => p.text))
    let hits = 0
    for (const p of paras) {
      const t = cached[p.text]
      if (t) {
        insertTrans(p.bi, t)
        hits++
      }
    }
    if (hits > 0) {
      $('#reflow-article').classList.add('has-trans', 'show-trans')
      const btn = $('#translate-btn') as HTMLButtonElement
      btn.classList.add('toggle-on')
      btn.textContent = hits >= paras.length ? '已译' : `译 ${hits}/${paras.length}`
      // 缓存不完整（重排版本变更导致段落键失配）→ 自动补翻缺失段
      if (hits < paras.length) void translateFlow()
    }
  } catch {
    /* 缓存不可用不影响阅读 */
  }
}

/** AI 翻译：缓存优先，缺的走 LLM，结果写回缓存 */
async function translateFlow(): Promise<void> {
  const article = $('#reflow-article')
  const btn = $('#translate-btn') as HTMLButtonElement
  if (!blocks || !doc) return
  if (article.classList.contains('has-trans')) {
    article.classList.toggle('show-trans')
    btn.classList.toggle('toggle-on', article.classList.contains('show-trans'))
    return
  }
  const status = await window.paperlite.llmStatus()
  const paras = paragraphIndexes()
  const texts = paras.map((p) => p.text)

  const cached = await window.paperlite.translationsGet(texts)
  for (const p of paras) {
    if (cached[p.text]) insertTrans(p.bi, cached[p.text])
  }
  if (Object.keys(cached).length > 0) article.classList.add('has-trans', 'show-trans')

  const missing = texts.filter((t) => !cached[t])
  if (missing.length === 0) {
    btn.textContent = '已译'
    btn.classList.add('toggle-on')
    return
  }
  if (!status.hasKey) {
    alert('部分段落无缓存译文，且未配置翻译 API Key（settings.json → llm.apiKey）。')
    return
  }

  btn.disabled = true
  btn.textContent = '翻译中…'
  const unsub = window.paperlite.onTranslationProgress(({ done, total, kind }) => {
    if (kind === 'interactive') btn.textContent = `翻译中 ${done}/${total}`
  })
  try {
    const result = await window.paperlite.translateParagraphs(missing)
    const items = missing
      .map((text, i) => ({ text, trans: result[i] ?? '' }))
      .filter((x) => x.trans)
    void window.paperlite.translationsPut(items)
    for (const p of paras) {
      const t = cached[p.text] ?? result[missing.indexOf(p.text)] ?? ''
      if (t) insertTrans(p.bi, t)
    }
    article.classList.add('has-trans', 'show-trans')
    btn.textContent = '已译'
    btn.classList.add('toggle-on')
  } catch (err) {
    console.error('[paperlite] 翻译失败', err)
    alert('翻译失败：' + String(err))
    btn.textContent = '译'
  } finally {
    unsub()
    btn.disabled = false
  }
}

function syncPageFromScroll(): void {
  const wrap = $('#reflow-wrap')
  const seps = wrap.querySelectorAll<HTMLElement>('.page-sep')
  let current = 1
  for (const s of seps) {
    if (s.offsetTop <= wrap.scrollTop + 140) current = Number(s.dataset['page'])
  }
  if (current !== pageNum) {
    pageNum = current
    ;($('#page-input') as HTMLInputElement).value = String(pageNum)
    clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      void window.paperlite.saveProgress(readingId, pageNum, doc?.numPages ?? null)
    }, 600)
  }
}

/* ── 原版模式 ─────────────────────────────── */

/* ── 原版模式：连续滚动（懒渲染） ── */

let pdfScrollBuilt = false
let pdfObserver: IntersectionObserver | null = null

function pdfScale(): number {
  if (!doc) return 1.25
  return fitWidth ? (Math.max(200, $('#page-wrap').clientWidth - 48) / 612) * zoom : 1.25 * zoom
}

/** 构建/重建纵向页列（占位高度先行，进入视口再渲染画布） */
async function buildPdfScroll(): Promise<void> {
  if (!doc) return
  const wrap = $('#page-wrap')
  const scroll = $('#pdf-scroll')
  pdfObserver?.disconnect()
  scroll.innerHTML = ''
  const scale = pdfScale()
  const vp1 = (await doc.getPage(1)).getViewport({ scale: 1 })
  for (let p = 1; p <= doc.numPages; p++) {
    const div = document.createElement('div')
    div.className = 'pdf-page'
    div.dataset['page'] = String(p)
    div.style.height = `${Math.floor(vp1.height * scale)}px`
    div.style.width = `${Math.floor(vp1.width * scale)}px`
    div.innerHTML = '<div class="pdf-ph">…</div>'
    scroll.appendChild(div)
  }
  pdfObserver = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) void renderPdfPage(Number((en.target as HTMLElement).dataset['page']))
      }
    },
    { root: wrap, rootMargin: '700px 0px' }
  )
  scroll.querySelectorAll('.pdf-page').forEach((el) => pdfObserver?.observe(el))
  pdfScrollBuilt = true
}

/** 渲染单页画布（带超时护栏；成功后替换占位） */
async function renderPdfPage(p: number): Promise<void> {
  if (!doc) return
  const div = $(`#pdf-scroll .pdf-page[data-page="${p}"]`)
  if (!div || div.dataset['rendered'] === '1') return
  const scale = pdfScale()
  if (div.dataset['zoom'] === String(scale.toFixed(3))) return
  div.dataset['zoom'] = scale.toFixed(3)
  try {
    const page = await doc.getPage(p)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.floor(viewport.width * dpr)
    canvas.height = Math.floor(viewport.height * dpr)
    canvas.style.width = `${Math.floor(viewport.width)}px`
    canvas.style.height = `${Math.floor(viewport.height)}px`
    const cx = canvas.getContext('2d')
    if (!cx) return
    await Promise.race([
      page.render({ canvasContext: cx, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('pdf-render-timeout')), 10000))
    ])
    if (div.dataset['zoom'] !== scale.toFixed(3)) return // 缩放已变，丢弃
    div.innerHTML = ''
    div.appendChild(canvas)
    div.dataset['rendered'] = '1'
  } catch {
    div.dataset['rendered'] = ''
    div.innerHTML = '<div class="pdf-ph">渲染未就绪</div>'
  }
}

/** 滚动位置 → 当前页码（同步 UI 与进度） */
let scrollSyncTimer: number | undefined
function syncPageFromPdfScroll(): void {
  const wrap = $('#page-wrap')
  const pages = [...wrap.querySelectorAll<HTMLElement>('.pdf-page')]
  let current = 1
  for (const el of pages) {
    if (el.offsetTop <= wrap.scrollTop + 120) current = Number(el.dataset['page'])
  }
  if (current !== pageNum && doc) {
    pageNum = Math.min(current, doc.numPages)
    ;($('#page-input') as HTMLInputElement).value = String(pageNum)
    clearTimeout(scrollSyncTimer)
    scrollSyncTimer = window.setTimeout(() => {
      void window.paperlite.saveProgress(readingId, pageNum, doc?.numPages ?? null)
    }, 600)
  }
}

/* ── 通用导航 ─────────────────────────────── */

function goTo(n: number): void {
  if (!doc) return
  const target = clamp(n, 1, doc.numPages)
  pageNum = target
  if (mode === 'reflow') {
    const sep = $(`#reflow-article .page-sep[data-page="${target}"]`)
    sep?.scrollIntoView({ block: 'start' })
    ;($('#page-input') as HTMLInputElement).value = String(target)
  } else {
    const el = $(`#pdf-scroll .pdf-page[data-page="${target}"]`)
    el?.scrollIntoView({ block: 'start' })
    ;($('#page-input') as HTMLInputElement).value = String(target)
  }
}

/* ── 文内搜索：块级命中 + 跳转 ── */

let searchHits: HTMLElement[] = []
let searchIdx = 0
let searchTimer: number | undefined

function clearSearchMarks(): void {
  document.querySelectorAll('.search-hit,.search-current').forEach((el) => {
    el.classList.remove('search-hit', 'search-current')
  })
}

function doSearch(): void {
  clearSearchMarks()
  searchHits = []
  searchIdx = 0
  const q = ($('#search-input') as HTMLInputElement).value.trim().toLowerCase()
  const count = $('#search-count')
  if (q.length < 1) {
    count.textContent = '0/0'
    return
  }
  const article = $('#reflow-article')
  article.querySelectorAll('p[data-bi], h1, h2, h3, h4, .formula').forEach((el) => {
    const t = (el.textContent ?? '').toLowerCase()
    if (t.includes(q)) {
      el.classList.add('search-hit')
      searchHits.push(el as HTMLElement)
    }
  })
  count.textContent = searchHits.length > 0 ? `1/${searchHits.length}` : '无结果'
  if (searchHits.length > 0) jumpSearch(0)
}

function jumpSearch(idx: number): void {
  if (searchHits.length === 0) return
  searchIdx = (idx + searchHits.length) % searchHits.length
  clearSearchMarks()
  searchHits.forEach((el) => el.classList.add('search-hit'))
  const cur = searchHits[searchIdx]
  cur.classList.add('search-current')
  cur.scrollIntoView({ block: 'center' })
  ;($('#search-count') as HTMLElement).textContent = `${searchIdx + 1}/${searchHits.length}`
}

function initSearchEvents(): void {
  $('#search-btn').addEventListener('click', () => {
    const bar = $('#search-bar')
    bar.hidden = !bar.hidden
    $('#search-btn').classList.toggle('toggle-on', !bar.hidden)
    if (!bar.hidden) ($('#search-input') as HTMLInputElement).focus()
    else clearSearchMarks()
  })
  $('#search-input').addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = window.setTimeout(doSearch, 300)
  })
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') jumpSearch(searchIdx + 1)
    if (e.key === 'Escape') $('#search-close').click()
  })
  $('#search-next').addEventListener('click', () => jumpSearch(searchIdx + 1))
  $('#search-prev').addEventListener('click', () => jumpSearch(searchIdx - 1))
  $('#search-close').addEventListener('click', () => {
    $('#search-bar').hidden = true
    $('#search-btn').classList.remove('toggle-on')
    clearSearchMarks()
  })
}

export function initReaderEvents(refreshShelf: () => void): void {
  initSearchEvents()
  initHighlightEvents(() => readingId)
  $('#back-btn').addEventListener('click', () => {
    closeReader()
    refreshShelf()
  })
  $('#prev-btn').addEventListener('click', () => goTo(pageNum - 1))
  $('#next-btn').addEventListener('click', () => goTo(pageNum + 1))
  $('#page-input').addEventListener('change', (e) => {
    goTo(Number((e.target as HTMLInputElement).value))
  })

  $('#reflow-btn').addEventListener('click', () => {
    if (!blocks) return
    mode = 'reflow'
    applyMode()
    goTo(pageNum)
  })
  $('#original-btn').addEventListener('click', () => {
    mode = 'original'
    applyMode()
    if (!pdfScrollBuilt) void buildPdfScroll().then(() => goTo(pageNum))
  })
  $('#font-dec').addEventListener('click', () => {
    reflowFont = clamp(reflowFont - 1, 13, 30)
    $('#reflow-article').style.setProperty('--reflow-font', `${reflowFont}px`)
  })
  $('#font-inc').addEventListener('click', () => {
    reflowFont = clamp(reflowFont + 1, 13, 30)
    $('#reflow-article').style.setProperty('--reflow-font', `${reflowFont}px`)
  })
  $('#translate-btn').addEventListener('click', () => void translateFlow())
  $('#width-btn').addEventListener('click', () => {
    widthIdx = (widthIdx + 1) % WIDTHS.length
    applyWidth()
  })
  $('#toc-btn').addEventListener('click', () => {
    const p = $('#toc-panel')
    p.hidden = !p.hidden
    $('#toc-btn').classList.toggle('toggle-on', !p.hidden)
  })
  $('#toc-list').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.toc-item')
    if (!btn) return
    const entry = toc[Number(btn.dataset['i'])]
    if (!entry) return
    if (entry.bi !== undefined && mode === 'reflow') {
      $(`#reflow-article [data-bi="${entry.bi}"]`)?.scrollIntoView({ block: 'start' })
    } else if (entry.page > 0) {
      goTo(entry.page)
    }
    $('#toc-panel').hidden = true
    $('#toc-btn').classList.remove('toggle-on')
  })

  $('#zoom-in-btn').addEventListener('click', () => {
    zoom = clamp(zoom * 1.2, 0.3, 5)
    void buildPdfScroll().then(() => goTo(pageNum))
  })
  $('#zoom-out-btn').addEventListener('click', () => {
    zoom = clamp(zoom / 1.2, 0.3, 5)
    void buildPdfScroll().then(() => goTo(pageNum))
  })
  $('#fit-btn').addEventListener('click', (e) => {
    fitWidth = !fitWidth
    zoom = 1
    ;(e.currentTarget as HTMLElement).classList.toggle('toggle-on', fitWidth)
    void buildPdfScroll().then(() => goTo(pageNum))
  })
  $('#page-wrap').addEventListener('scroll', () => {
    if (mode === 'original') syncPageFromPdfScroll()
  })
  $('#page-wrap').addEventListener(
    'wheel',
    (e) => {
      if (!doc || mode !== 'original' || !e.ctrlKey) return
      e.preventDefault()
      zoom = clamp(zoom * (e.deltaY < 0 ? 1.1 : 0.9), 0.3, 5)
      void buildPdfScroll().then(() => goTo(pageNum))
    },
    { passive: false }
  )
  $('#reflow-wrap').addEventListener('scroll', () => {
    clearTimeout(scrollTimer)
    scrollTimer = window.setTimeout(syncPageFromScroll, 250)
  })
  window.addEventListener('keydown', (e) => {
    if ($('#reader').hidden) return
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') goTo(pageNum - 1)
    if (e.key === 'ArrowRight' || e.key === 'PageDown') goTo(pageNum + 1)
  })
}
