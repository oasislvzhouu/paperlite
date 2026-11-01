/** 划线高亮与笔记：选区 → 偏移定位 → <mark> 包裹 → SQLite 持久化 → 笔记弹窗 */

export interface HlRow {
  id: number
  block_index: number
  start_offset: number
  end_offset: number
  text: string
  color: string
  note: string
}

let rows: HlRow[] = []
/** 待写入的选区信息（点「笔记」时弹出编辑器，选区可能已丢失） */
let pending: { bi: number; start: number; end: number; text: string } | null = null
/** 正在编辑的既有高亮 id（null = 新建） */
let editingId: number | null = null
let currentColor = 'yellow'

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T

export async function loadHighlights(readingId: number): Promise<void> {
  try {
    rows = await window.paperlite.listHighlights(readingId)
  } catch {
    rows = []
  }
}

function textNodePoints(el: HTMLElement): {
  nodes: Text[]
  starts: number[]
} {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  const starts: number[] = []
  let cum = 0
  while (walker.nextNode()) {
    const n = walker.currentNode as Text
    nodes.push(n)
    starts.push(cum)
    cum += n.data.length
  }
  return { nodes, starts }
}

function locate(nodes: Text[], starts: number[], offset: number): { node: Text; off: number } | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (offset >= starts[i]) return { node: nodes[i], off: offset - starts[i] }
  }
  return null
}

/** 把已保存的高亮应用到当前文章 DOM（renderReflow 之后调用一次） */
export function applyHighlights(): void {
  const article = $('#reflow-article')
  const byBlock = new Map<number, HlRow[]>()
  for (const r of rows) {
    const list = byBlock.get(r.block_index) ?? []
    list.push(r)
    byBlock.set(r.block_index, list)
  }
  for (const [bi, list] of byBlock) {
    const el = article.querySelector<HTMLElement>(`p[data-bi="${bi}"]`)
    if (!el) continue
    const sorted = [...list].sort((a, b) => a.start_offset - b.start_offset)
    let cursor = -1
    for (const r of sorted) {
      const s = Math.max(r.start_offset, cursor < 0 ? 0 : cursor)
      const e = r.end_offset
      if (e <= s) continue
      wrapRange(el, s, e, r)
      cursor = e
    }
  }
}

function wrapRange(el: HTMLElement, s: number, e: number, r: HlRow): void {
  const { nodes, starts } = textNodePoints(el)
  const a = locate(nodes, starts, s)
  const b = locate(nodes, starts, e)
  if (!a || !b) return
  try {
    const range = document.createRange()
    range.setStart(a.node, a.off)
    range.setEnd(b.node, b.off)
    const mark = document.createElement('mark')
    mark.className = `hl hl-${r.color}${r.note ? ' has-note' : ''}`
    mark.dataset['hid'] = String(r.id)
    if (r.note) mark.title = r.note
    range.surroundContents(mark)
  } catch {
    /* 选区跨越 sub/sup 元素边界时 surroundContents 会抛错，跳过 */
  }
}

/** 读取当前选区：仅当落在正文段落 p[data-bi] 内 */
function selectionInfo(): { bi: number; start: number; end: number; text: string } | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  const article = $('#reflow-article')
  const startEl =
    range.startContainer.nodeType === Node.TEXT_NODE
      ? range.startContainer.parentElement
      : (range.startContainer as HTMLElement)
  const p = startEl?.closest?.('p[data-bi]') ?? null
  if (!p || !article.contains(p)) return null
  const endEl =
    range.endContainer.nodeType === Node.TEXT_NODE
      ? range.endContainer.parentElement
      : (range.endContainer as HTMLElement)
  if (!endEl || !p.contains(endEl)) return null // 跨段落选区不支持
  const { nodes, starts } = textNodePoints(p as HTMLElement)
  const findOff = (node: Node, off: number): number => {
    for (let i = 0; i < nodes.length; i++) if (nodes[i] === node) return starts[i] + off
    return -1
  }
  const start = findOff(range.startContainer, range.startOffset)
  const end = findOff(range.endContainer, range.endOffset)
  if (start < 0 || end <= start) return null
  return { bi: Number((p as HTMLElement).dataset['bi']), start, end, text: sel.toString() }
}

function hidePops(): void {
  $('#hl-pop').hidden = true
  $('#note-pop').hidden = true
}

function showAt(pop: HTMLElement, x: number, y: number): void {
  pop.hidden = false
  const rect = pop.getBoundingClientRect()
  const left = Math.min(Math.max(8, x - rect.width / 2), window.innerWidth - rect.width - 8)
  pop.style.left = `${left}px`
  pop.style.top = `${Math.max(8, y - rect.height - 10)}px`
}

async function refresh(readingId: number): Promise<void> {
  await loadHighlights(readingId)
  applyHighlights()
}

function openNoteEditor(x: number, y: number, row?: HlRow): void {
  editingId = row?.id ?? null
  currentColor = row?.color ?? 'yellow'
  const noteText = $('#note-text') as HTMLTextAreaElement
  noteText.value = row?.note ?? ''
  document.querySelectorAll('#note-pop .swatch').forEach((s) => {
    s.classList.toggle('active', (s as HTMLElement).dataset['color'] === currentColor)
  })
  showAt($('#note-pop'), x, y)
  $('#note-text').focus()
}

export function initHighlightEvents(getReadingId: () => number): void {
  const article = $('#reflow-article')

  // 选中文字 → 浮动菜单
  article.addEventListener('mouseup', () => {
    if (!$('#reader').hidden === false) return
    if ($('#reader').hidden) return
    const info = selectionInfo()
    if (!info || info.text.trim().length < 1) {
      if ($('#hl-pop').hidden === false) $('#hl-pop').hidden = true
      return
    }
    pending = info
    const rect = window.getSelection()!.getRangeAt(0).getBoundingClientRect()
    showAt($('#hl-pop'), rect.left + rect.width / 2, rect.top)
  })

  $('#hl-pop').addEventListener('click', async (e) => {
    const act = (e.target as HTMLElement).closest('button')?.dataset['act']
    if (!act || !pending) return
    const rect = $('#hl-pop').getBoundingClientRect()
    if (act === 'copy') {
      void navigator.clipboard?.writeText(pending.text)
      hidePops()
      window.getSelection()?.removeAllRanges()
      return
    }
    if (act === 'hl') {
      await window.paperlite.addHighlight(
        getReadingId(), pending.bi, pending.start, pending.end, pending.text, 'yellow', ''
      )
      await refresh(getReadingId())
      hidePops()
      window.getSelection()?.removeAllRanges()
      return
    }
    // note：打开编辑器（保留 pending）
    openNoteEditor(rect.left + rect.width / 2, rect.top)
    $('#hl-pop').hidden = true
  })

  // 点击已有高亮 → 编辑笔记/颜色/删除
  article.addEventListener('click', (e) => {
    const mark = (e.target as HTMLElement).closest<HTMLElement>('mark.hl')
    if (!mark) return
    const row = rows.find((r) => r.id === Number(mark.dataset['hid']))
    if (!row) return
    const rect = mark.getBoundingClientRect()
    e.stopPropagation()
    openNoteEditor(rect.left + rect.width / 2, rect.top, row)
  })

  document.querySelectorAll('#note-pop .swatch').forEach((s) =>
    s.addEventListener('click', () => {
      currentColor = (s as HTMLElement).dataset['color'] ?? 'yellow'
      document.querySelectorAll('#note-pop .swatch').forEach((x) => {
        x.classList.toggle('active', x === s)
      })
    })
  )

  $('#note-save').addEventListener('click', async () => {
    const note = ($('#note-text') as HTMLTextAreaElement).value.trim()
    if (editingId !== null) {
      await window.paperlite.updateHighlight(editingId, currentColor, note)
    } else if (pending) {
      await window.paperlite.addHighlight(
        getReadingId(), pending.bi, pending.start, pending.end, pending.text, currentColor, note
      )
    }
    pending = null
    editingId = null
    hidePops()
    await refresh(getReadingId())
  })

  $('#note-delete').addEventListener('click', async () => {
    if (editingId !== null) {
      await window.paperlite.removeHighlight(editingId)
      await refresh(getReadingId())
    }
    pending = null
    editingId = null
    hidePops()
  })

  document.addEventListener('mousedown', (e) => {
    const t = e.target as HTMLElement
    if (t.closest('#note-pop') || t.closest('#hl-pop') || t.closest('mark.hl')) return
    if (!$('#note-pop').hidden || !$('#hl-pop').hidden) hidePops()
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hidePops()
  })
}
