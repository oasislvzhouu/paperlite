/**
 * 笔记侧栏（对标 Scholaread 右侧批注面板）：
 * - 三个标签：全部 / 批注（有笔记文字）/ 高亮
 * - 颜色筛选（黄/绿/蓝）
 * - 每条：颜色点、页码、引文、笔记正文；✎ 编辑、✕ 删除
 * - 与正文双向联动：点条目 → 正文闪烁定位；点正文高亮 → 侧栏滚动到该条
 */
import { editHighlightById, getHighlightRows, onHighlightsChanged, type HlRow } from './highlights'

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T

type Tab = 'all' | 'note' | 'hl'
type ColorFilter = 'all' | 'yellow' | 'green' | 'blue'

let tab: Tab = 'all'
let colorFilter: ColorFilter = 'all'

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

function filtered(): HlRow[] {
  let rows = getHighlightRows()
  if (tab === 'note') rows = rows.filter((r) => r.note.trim().length > 0)
  if (tab === 'hl') rows = rows.filter((r) => r.note.trim().length === 0)
  if (colorFilter !== 'all') rows = rows.filter((r) => r.color === colorFilter)
  return [...rows].sort((a, b) => a.block_index - b.block_index || a.start_offset - b.start_offset)
}

function renderCounts(): void {
  const all = getHighlightRows()
  const set = (id: string, v: number): void => {
    const el = document.querySelector<HTMLElement>(`#${id}`)
    if (el) el.textContent = String(v)
  }
  set('cnt-all', all.length)
  set('cnt-note', all.filter((r) => r.note.trim().length > 0).length)
  set('cnt-hl', all.filter((r) => r.note.trim().length === 0).length)
  const badge = document.querySelector<HTMLElement>('#notes-count')
  if (badge) badge.textContent = String(all.length)
}

export function renderNotesPanel(): void {
  const list = $('#notes-list')
  renderCounts()
  if (!list) return
  const rows = filtered()
  if (rows.length === 0) {
    const tip =
      tab === 'note' ? '还没有带笔记的批注' : tab === 'hl' ? '还没有纯高亮' : '还没有高亮或笔记'
    list.innerHTML = `<div class="notes-empty">${tip}<br/><span>选中正文文字即可添加；点「✎」可编辑批注</span></div>`
    return
  }
  list.innerHTML = rows
    .map((r) => {
      const page = pageOfBlock(r.block_index)
      const quote = r.text.length > 120 ? `${r.text.slice(0, 120)}…` : r.text
      const note = r.note.trim()
      return `<article class="note-item" data-hid="${r.id}">
        <div class="note-head">
          <span class="note-dot c-${esc(r.color)}"></span>
          <span class="note-page">${page ? `P${page}` : ''}</span>
          <button class="note-edit" data-edit="${r.id}" title="编辑这条批注">✎</button>
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

/** 正文 → 侧栏：滚动到对应条目并短暂高亮卡片 */
function focusItem(hid: number): void {
  const panel = $('#notes-panel')
  if (!panel || panel.hidden) return
  let item = panel.querySelector<HTMLElement>(`.note-item[data-hid="${hid}"]`)
  if (!item) {
    // 当前筛选下看不到该条 → 切回「全部 + 全部颜色」再定位
    tab = 'all'
    colorFilter = 'all'
    syncControls()
    renderNotesPanel()
    item = panel.querySelector<HTMLElement>(`.note-item[data-hid="${hid}"]`)
  }
  if (!item) return
  item.scrollIntoView({ block: 'nearest' })
  panel.querySelectorAll('.note-item.active').forEach((x) => x.classList.remove('active'))
  item.classList.add('active')
  window.setTimeout(() => item?.classList.remove('active'), 1600)
}

function syncControls(): void {
  document.querySelectorAll<HTMLButtonElement>('.notes-tabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset['tab'] === tab)
  })
  document.querySelectorAll<HTMLButtonElement>('.notes-colors button').forEach((b) => {
    b.classList.toggle('on', b.dataset['color'] === colorFilter)
  })
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

  document.querySelectorAll<HTMLButtonElement>('.notes-tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      tab = (b.dataset['tab'] as Tab) ?? 'all'
      syncControls()
      renderNotesPanel()
    })
  })
  document.querySelectorAll<HTMLButtonElement>('.notes-colors button').forEach((b) => {
    b.addEventListener('click', () => {
      colorFilter = (b.dataset['color'] as ColorFilter) ?? 'all'
      syncControls()
      renderNotesPanel()
    })
  })

  $('#notes-list')?.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    const del = t.closest<HTMLElement>('[data-del]')
    if (del) {
      e.stopPropagation()
      void window.paperlite.removeHighlight(Number(del.dataset['del']))
      return
    }
    const edit = t.closest<HTMLElement>('[data-edit]')
    if (edit) {
      e.stopPropagation()
      editHighlightById(Number(edit.dataset['edit']))
      return
    }
    const item = t.closest<HTMLElement>('.note-item')
    if (item) flashMark(Number(item.dataset['hid']))
  })

  onHighlightsChanged(() => {
    if (panel && !panel.hidden) renderNotesPanel()
    else renderCounts()
  })

  // 正文点高亮 → 侧栏联动定位
  document.addEventListener('pl:hl-focus', (e) => {
    const id = Number((e as CustomEvent<{ id: number }>).detail?.id)
    if (Number.isFinite(id)) focusItem(id)
  })

  syncControls()
  renderCounts()
}
