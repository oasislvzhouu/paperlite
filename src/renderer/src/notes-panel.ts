/**
 * 笔记侧栏（对标 Scholaread 的右侧批注面板）：
 * 汇总当前文献的全部高亮/笔记，按正文顺序列出，点击跳转、可删除。
 * 数据来自 highlights 模块（SQLite 持久化），新增/编辑/删除后自动刷新。
 */
import { getHighlightRows, onHighlightsChanged } from './highlights'

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T

/** 高亮所在块的页码（沿 DOM 向前找最近的 .page-sep） */
function pageOfBlock(bi: number): number | null {
  const el = document.querySelector<HTMLElement>(`#reflow-article [data-bi="${bi}"]`)
  if (!el) return null
  let cur: Element | null = el.previousElementSibling
  while (cur) {
    if (cur.classList.contains('page-sep')) {
      const p = Number((cur as HTMLElement).dataset['page'])
      return Number.isFinite(p) ? p : null
    }
    cur = cur.previousElementSibling
  }
  return null
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )
}

export function renderNotesPanel(): void {
  const list = $('#notes-list')
  const count = $('#notes-count')
  const rows = getHighlightRows()
  if (count) count.textContent = String(rows.length)
  if (!list) return
  if (rows.length === 0) {
    list.innerHTML = '<div class="notes-empty">还没有高亮或笔记<br/><span>选中正文文字即可添加</span></div>'
    return
  }
  const sorted = [...rows].sort((a, b) => a.block_index - b.block_index || a.start_offset - b.start_offset)
  list.innerHTML = sorted
    .map((r) => {
      const page = pageOfBlock(r.block_index)
      const quote = r.text.length > 120 ? `${r.text.slice(0, 120)}…` : r.text
      const note = r.note?.trim()
      return `<article class="note-item" data-hid="${r.id}">
        <div class="note-head">
          <span class="note-dot c-${esc(r.color)}"></span>
          <span class="note-page">${page ? `P${page}` : ''}</span>
          <button class="note-del" data-del="${r.id}" title="删除这条批注">✕</button>
        </div>
        <blockquote class="note-quote">${esc(quote)}</blockquote>
        ${note ? `<p class="note-text">${esc(note)}</p>` : ''}
      </article>`
    })
    .join('')
}

function flashMark(hid: number): void {
  const mark = document.querySelector<HTMLElement>(`#reflow-article mark.hl[data-hid="${hid}"]`)
  if (!mark) return
  mark.scrollIntoView({ block: 'center', behavior: 'smooth' })
  mark.classList.remove('hl-flash')
  void mark.offsetWidth
  mark.classList.add('hl-flash')
  window.setTimeout(() => mark.classList.remove('hl-flash'), 1500)
}

export function initNotesPanel(): void {
  const panel = $('#notes-panel')
  const btn = $('#notes-btn')

  btn?.addEventListener('click', () => {
    if (!panel) return
    panel.hidden = !panel.hidden
    btn.classList.toggle('toggle-on', !panel.hidden)
    $('#reader').classList.toggle('notes-open', !panel.hidden)
    if (!panel.hidden) renderNotesPanel()
  })
  $('#notes-close')?.addEventListener('click', () => {
    if (!panel) return
    panel.hidden = true
    btn?.classList.remove('toggle-on')
    $('#reader').classList.remove('notes-open')
  })

  $('#notes-list')?.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    const del = t.closest<HTMLElement>('[data-del]')
    if (del) {
      e.stopPropagation()
      const id = Number(del.dataset['del'])
      void window.paperlite.removeHighlight(id).then(() => {
        // highlights.refresh 会触发 onHighlightsChanged → 自动重绘
      })
      return
    }
    const item = t.closest<HTMLElement>('.note-item')
    if (item) flashMark(Number(item.dataset['hid']))
  })

  onHighlightsChanged(() => {
    if (panel && !panel.hidden) renderNotesPanel()
    else {
      const count = $('#notes-count')
      if (count) count.textContent = String(getHighlightRows().length)
    }
  })

  // 打开文献时先刷新一次计数
  onHighlightsChanged(renderCountOnly)
}

function renderCountOnly(): void {
  const count = $('#notes-count')
  if (count) count.textContent = String(getHighlightRows().length)
}
