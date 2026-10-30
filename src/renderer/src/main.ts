import * as pdfjsLib from 'pdfjs-dist'
import PdfjsWorker from './pdf-worker?worker&inline'
import './style.css'
import { initReaderEvents, openReader } from './reader'
import { extractReflowBlocks } from './reflow'
import type { ReadingMeta } from '../../shared/types'

// 内联 worker（自带 toHex polyfill），不再依赖外部 workerSrc 资源路径
const pdfWorker = new PdfjsWorker()
pdfWorker.onerror = (e) => console.error('[paperlite] pdf worker 启动失败:', e.message ?? e)
pdfjsLib.GlobalWorkerOptions.workerPort = pdfWorker

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T

let allReadings: ReadingMeta[] = []
const thumbPending = new Set<number>()

function fmtSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
}

async function refreshShelf(): Promise<void> {
  allReadings = await window.paperlite.listReadings()
  renderShelf()
}

function renderShelf(): void {
  const kw = ($('#search') as HTMLInputElement).value.trim().toLowerCase()
  const list = kw
    ? allReadings.filter((r) => r.title.toLowerCase().includes(kw))
    : allReadings
  const shelf = $('#shelf')
  shelf.innerHTML = ''
  $('#empty-tip').hidden = list.length > 0 || allReadings.length > 0
  for (const r of list) {
    const card = document.createElement('article')
    card.className = 'card'
    card.title = r.title
    card.innerHTML = `
      <div class="thumb">
        <div class="thumb-fallback" hidden>📄</div>
        <img data-id="${r.id}" alt="" loading="lazy" src="${window.paperlite.thumbUrl(r.id)}" />
      </div>
      <div class="card-body">
        <div class="card-title ellipsis">${escapeHtml(r.title)}</div>
        <div class="card-meta">
          ${r.page_count ? `${r.page_count} 页 · ` : ''}${fmtSize(r.size_bytes)} · ${fmtDate(
            r.last_opened_at ?? r.added_at
          )}${r.last_page && r.page_count ? ` · 读到 ${r.last_page} 页` : ''}
        </div>
        <div class="card-actions">
          <button class="primary open-btn">打开</button>
          <button class="danger del-btn">移出书架</button>
        </div>
      </div>`
    const img = card.querySelector<HTMLImageElement>('img')!
    const fallback = card.querySelector<HTMLElement>('.thumb-fallback')!
    img.addEventListener('error', () => {
      img.hidden = true
      fallback.hidden = false
      // 缩略图缺失（如旧数据）→ 懒生成一次；失败则保持占位图标
      if (!thumbPending.has(r.id)) {
        thumbPending.add(r.id)
        void generateThumb(r.id)
      }
    })
    card.querySelector('.open-btn')!.addEventListener('click', () => {
      void openReader(r.id)
    })
    card.querySelector('.del-btn')!.addEventListener('click', async () => {
      if (!confirm(`把《${r.title}》移出书架？本地文件会一并删除。`)) return
      await window.paperlite.deleteReading(r.id)
      void refreshShelf()
    })
    shelf.appendChild(card)
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )
}

/** 导入后立刻生成第一页缩略图（240px 宽） */
async function generateThumb(id: number): Promise<void> {
  try {
    const task = pdfjsLib.getDocument({
      url: window.paperlite.pdfUrl(id),
      cMapUrl: 'assets/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'assets/standard_fonts/'
    })
    const d = await task.promise
    const page = await d.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: 240 / base.width })
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    const ctx = canvas.getContext('2d')
    if (ctx) {
      await page.render({ canvasContext: ctx, viewport }).promise
      await window.paperlite.saveThumb(id, canvas.toDataURL('image/png'))
    }
    await task.destroy()
    const img = document.querySelector<HTMLImageElement>(`img[data-id="${id}"]`)
    if (img) {
      img.hidden = false
      img.src = `${window.paperlite.thumbUrl(id)}?t=${Date.now()}`
      img.closest('.thumb')?.querySelector('.thumb-fallback')?.setAttribute('hidden', '')
    }
  } catch (err) {
    console.error('[paperlite] 缩略图生成失败 id=' + id, err)
    throw err
  }
}

/** 导入后后台预翻译：提取段落 → 主进程排队翻译并写入缓存库 */
async function prefetchTranslations(meta: ReadingMeta): Promise<void> {
  try {
    const task = pdfjsLib.getDocument({
      url: window.paperlite.pdfUrl(meta.id),
      cMapUrl: 'assets/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'assets/standard_fonts/'
    })
    const d = await task.promise
    const blks = await extractReflowBlocks(d)
    await task.destroy()
    const texts = blks
      .filter((b) => b.kind === 'paragraph' && b.text.length >= 40)
      .map((b) => b.text)
    if (texts.length > 0) {
      await window.paperlite.translationsPrefetch(texts)
    }
  } catch (err) {
    console.warn('[paperlite] 预翻译排队失败（忽略）', err)
  }
}

async function importFlow(): Promise<void> {
  const { imported, duplicates, invalid } = await window.paperlite.importPdfs()
  const notes: string[] = []
  if (duplicates.length > 0) notes.push(`《${duplicates[0]}》等 ${duplicates.length} 个文件已在书架中，跳过重复导入`)
  if (invalid.length > 0) notes.push(`${invalid.length} 个文件不是 PDF，已忽略`)
  if (notes.length > 0) alert(notes.join('\n'))
  if (imported.length > 0) {
    await refreshShelf()
    for (const r of imported) {
      await generateThumb(r.id).catch(() => {})
    }
    // 后台预翻译（不阻塞界面），完成后下次打开即秒显
    for (const r of imported) void prefetchTranslations(r)
  }
}

function init(): void {
  $('#import-btn').addEventListener('click', () => void importFlow())
  $('#search').addEventListener('input', renderShelf)
  initReaderEvents(() => void refreshShelf())
  void refreshShelf()
}

init()
