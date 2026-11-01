import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { extractReflowBlocks, cropPageImages, type ReflowBlock } from './reflow'
import { applyHighlights, initHighlightEvents, loadHighlights } from './highlights'

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
    applyWidth()
    goTo(pageNum)
    void loadHighlights(id).then(() => applyHighlights())
    void hydrateTranslations()
    // worker 在密集文本提取后有一段"泄洪期"（其间 render 会超时），
    // 图片挂载延迟启动避开，公式识别随后
    window.setTimeout(() => {
      if (readingId === id && mode === 'reflow') {
        void attachImages().then(() => {
          if (readingId === id) void upgradeFormulas()
        })
      }
    }, 8000)
  } else {
    applyWidth()
    void render()
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
function insertFigure(pageNo: number, yTop: number, dataUrl: string): void {
  const article = $('#reflow-article')
  if (!blocks) return
  const key = `${pageNo}-${Math.round(yTop)}`
  if (article.querySelector(`figure[data-key="${key}"]`)) return
  const fig = document.createElement('figure')
  fig.className = 'figure'
  fig.dataset['key'] = key
  const img = document.createElement('img')
  img.src = dataUrl
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

async function attachImages(): Promise<void> {
  if (!doc || mode !== 'reflow') return
  for (let p = 1; p <= doc.numPages; p++) {
    if (readingId === 0) return
    try {
      const page = await doc.getPage(p)
      const vp = page.getViewport({ scale: 1 })
      const imgs = await Promise.race([
        cropPageImages(page, vp.width, vp.height, pdfjsLib.OPS),
        new Promise<Array<{ yTop: number; image?: string }>>((resolve) =>
          setTimeout(() => resolve([]), 15000)
        )
      ])
      for (const im of imgs) {
        if (im.image) insertFigure(p, im.yTop, im.image)
      }
    } catch {
      /* 单页失败跳过 */
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
  $('#page-wrap').addEventListener(
    'wheel',
    (e) => {
      if (!doc || mode !== 'original') return
      const wrap = $('#page-wrap')
      if (e.ctrlKey) {
        e.preventDefault()
        zoom = clamp(zoom * (e.deltaY < 0 ? 1.1 : 0.9), 0.3, 5)
        void render()
        return
      }
      // 滚轮边缘翻页：页面顶/底再继续滚动 = 上一页/下一页
      const atBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 2
      const atTop = wrap.scrollTop <= 2
      if (e.deltaY > 0 && atBottom) {
        e.preventDefault()
        goTo(pageNum + 1)
      } else if (e.deltaY < 0 && atTop) {
        e.preventDefault()
        goTo(pageNum - 1)
      }
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
