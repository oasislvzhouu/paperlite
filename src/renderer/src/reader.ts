import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { extractReflowBlocks, type ReflowBlock } from './reflow'

type Mode = 'reflow' | 'original'

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
  task = pdfjsLib.getDocument({
    url: window.paperlite.pdfUrl(id),
    cMapUrl: 'assets/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'assets/standard_fonts/'
  })
  doc = await task.promise
  readingId = id
  pageNum = clamp(info.lastPage || 1, 1, doc.numPages)
  zoom = 1
  pageCanvasCache.clear()
  $('#reader-title').textContent = info.title
  $('#page-total').textContent = String(doc.numPages)
  $('#shelf').hidden = true
  $('#shelf-header').hidden = true
  $('#empty-tip').hidden = true
  $('#reader').hidden = false

  // 解析重排（大文件可能要一两秒，给加载提示）
  $('#reflow-loading').hidden = false
  try {
    blocks = await extractReflowBlocks(doc)
  } catch {
    blocks = null
  }
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
    goTo(pageNum)
    void hydrateTranslations()
    void upgradeFormulas()
  } else {
    void render()
  }
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
    } else if (b.kind === 'heading') {
      const lvl = clamp(b.level ?? 3, 1, 4)
      parts.push(`<h${lvl} data-bi="${bi}">${body}</h${lvl}>`)
    } else {
      parts.push(`<p data-bi="${bi}">${body}</p>`)
    }
  })
  article.innerHTML = parts.join('\n')
  article.style.setProperty('--reflow-font', `${reflowFont}px`)
  article.classList.remove('show-trans', 'has-trans')
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
        katex.render(latex, el, { displayMode: true, throwOnError: false })
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
    .filter((x) => x.b.kind === 'paragraph')
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

async function render(): Promise<void> {
  if (!doc) return
  const page = await doc.getPage(pageNum)
  const base = page.getViewport({ scale: 1 })
  const wrap = $('#page-wrap')
  const avail = Math.max(wrap.clientWidth - 48, 200)
  const scale = (fitWidth ? avail / base.width : 1.25) * zoom
  const viewport = page.getViewport({ scale })
  const canvas = $('#pdf-canvas') as HTMLCanvasElement
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.floor(viewport.width * dpr)
  canvas.height = Math.floor(viewport.height * dpr)
  canvas.style.width = `${Math.floor(viewport.width)}px`
  canvas.style.height = `${Math.floor(viewport.height)}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  await page.render({
    canvasContext: ctx,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
  }).promise
  ;($('#page-input') as HTMLInputElement).value = String(pageNum)
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    void window.paperlite.saveProgress(readingId, pageNum, doc?.numPages ?? null)
  }, 600)
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
    void render()
  }
}

export function initReaderEvents(refreshShelf: () => void): void {
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
    void render()
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

  $('#zoom-in-btn').addEventListener('click', () => {
    zoom = clamp(zoom * 1.2, 0.3, 5)
    void render()
  })
  $('#zoom-out-btn').addEventListener('click', () => {
    zoom = clamp(zoom / 1.2, 0.3, 5)
    void render()
  })
  $('#fit-btn').addEventListener('click', (e) => {
    fitWidth = !fitWidth
    zoom = 1
    ;(e.currentTarget as HTMLElement).classList.toggle('toggle-on', fitWidth)
    void render()
  })
  $('#page-wrap').addEventListener('wheel', (e) => {
    if (!doc || !e.ctrlKey || mode !== 'original') return
    e.preventDefault()
    zoom = clamp(zoom * (e.deltaY < 0 ? 1.1 : 0.9), 0.3, 5)
    void render()
  })
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
