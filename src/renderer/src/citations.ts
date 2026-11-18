/**
 * 文内引用角标 → 可点击链接（对标 Scholaread 的 .pdf_reference 样式）。
 * 渲染完成后把正文段落里的 "[12]"、"[12], [13]" 包成 <a class="cite">，
 * 点击滚动到参考文献区对应条目并闪烁高亮。
 * 注意：只改 DOM 结构不改文本，highlight 的字符偏移仍然有效。
 */

const CITE_TEST = /\[\d{1,3}\]/
const CITE_GLOBAL = /\[(\d{1,3})\]/g

/** 把正文中的引用角标转成链接（幂等） */
export function linkCitations(): void {
  const article = document.querySelector<HTMLElement>('#reflow-article')
  if (!article) return
  const paras = article.querySelectorAll<HTMLElement>('p[data-bi]')
  for (const p of paras) {
    if (p.classList.contains('trans')) continue // 译文里的编号不动
    if (p.classList.contains('ref-entry')) continue // 文献条目自身不动
    linkIn(p)
  }
}

function linkIn(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const targets: Text[] = []
  while (walker.nextNode()) {
    const n = walker.currentNode as Text
    if (n.parentElement?.closest('a.cite')) continue
    if (CITE_TEST.test(n.data)) targets.push(n)
  }
  for (const node of targets) splitNode(node)
}

function splitNode(node: Text): void {
  const text = node.data
  const frag = document.createDocumentFragment()
  let last = 0
  CITE_GLOBAL.lastIndex = 0
  for (const m of text.matchAll(CITE_GLOBAL)) {
    const i = m.index ?? 0
    if (i > last) frag.appendChild(document.createTextNode(text.slice(last, i)))
    const a = document.createElement('a')
    a.className = 'cite'
    a.dataset['cite'] = m[1]
    a.textContent = m[0]
    a.title = `跳转到参考文献 [${m[1]}]`
    frag.appendChild(a)
    last = i + m[0].length
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)))
  node.parentNode?.replaceChild(frag, node)
}

/** 点击引用角标 → 跳到参考文献条目 */
export function initCitationEvents(): void {
  const article = document.querySelector<HTMLElement>('#reflow-article')
  if (!article) return
  article.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('a.cite')
    if (!a) return
    e.preventDefault()
    e.stopPropagation()
    jumpToRef(a.dataset['cite'] ?? '', a)
  })
}

function jumpToRef(n: string, from: HTMLElement): void {
  if (!n) return
  const article = document.querySelector<HTMLElement>('#reflow-article')
  if (!article) return
  const entries = [...article.querySelectorAll<HTMLElement>('p.ref-entry')]
  if (entries.length === 0) {
    toast('本文没有参考文献区')
    return
  }
  // 优先按条目内出现的 "[n]" 精确匹配（"[1]" 不会误配 "[10]"）。
  // 很多 PDF 的角标在提取时丢失，条目里根本没有编号 —— 退化为
  // "第 n 条"（n 从 1 起）定位，仍能落到参考文献区的正确位置附近
  const tag = `[${n}]`
  const re = new RegExp('\\[' + n + '\\]')
  const hit =
    entries.find((p) => re.test(p.textContent ?? '')) ??
    entries[Math.min(entries.length - 1, Math.max(0, Number(n) - 1))]
  if (!hit) {
    toast(`未找到文献 ${tag}`)
    return
  }
  hit.scrollIntoView({ block: 'center', behavior: 'smooth' })
  hit.classList.remove('ref-flash')
  // 强制重排以便重复点击也重新触发动画
  void hit.offsetWidth
  hit.classList.add('ref-flash')
  window.setTimeout(() => hit.classList.remove('ref-flash'), 1600)
  from.classList.add('cite-active')
  window.setTimeout(() => from.classList.remove('cite-active'), 1200)
}

let toastTimer = 0
function toast(msg: string): void {
  const chip = document.querySelector<HTMLElement>('#trans-status')
  const text = document.querySelector<HTMLElement>('#trans-status-text')
  if (!chip || !text) return
  text.textContent = msg
  chip.classList.remove('done')
  chip.hidden = false
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    chip.classList.add('done')
    window.setTimeout(() => (chip.hidden = true), 450)
  }, 1600)
}
