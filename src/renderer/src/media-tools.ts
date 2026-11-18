/**
 * 公式 / 插图的悬浮工具条（对标 Scholaread 的 ReaderButtonFormulaToolbar /
 * ReaderButtonImageToolbar：在 .no-reflow-formula / .no-reflow-image 上注入
 * 操作按钮）。
 *
 * 提供：放大（灯箱）、复制图片到剪贴板、下载 PNG、AI 解释（视觉模型）。
 * 按钮按需注入（pointerenter 时），避免给每张图都预先建 DOM。
 */

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T

type Kind = 'formula' | 'figure'

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(',')
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? 'image/png'
  const bin = atob(body)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

function decorate(host: HTMLElement, img: HTMLImageElement, kind: Kind): void {
  if (host.dataset['tools'] === '1') return
  host.dataset['tools'] = '1'
  host.classList.add('has-media-tools')
  const bar = document.createElement('div')
  bar.className = 'media-tools'
  bar.innerHTML = `
    <button data-act="zoom" title="放大查看">⤢</button>
    <button data-act="copy" title="复制图片">⧉</button>
    <button data-act="save" title="保存为 PNG">⤓</button>
    <button data-act="explain" title="AI 解释（公式含义 / 图表结论）">✨</button>`
  bar.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('button')?.dataset['act']
    if (!act) return
    e.stopPropagation()
    e.preventDefault()
    const src = img.src
    if (act === 'zoom') {
      openLightbox(src, img.alt || '')
    } else if (act === 'copy') {
      void copyImage(src)
    } else if (act === 'save') {
      downloadImage(src, kind)
    } else if (act === 'explain') {
      void explain(src, kind, bar)
    }
  })
  host.appendChild(bar)
}

async function copyImage(src: string): Promise<void> {
  try {
    const blob = dataUrlToBlob(src)
    const png = await toPng(blob)
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    toast('图片已复制到剪贴板')
  } catch {
    toast('复制失败，可改用「保存为 PNG」')
  }
}

/** 统一转 PNG（剪贴板对 JPEG/PNG 都有要求，统一转最稳） */
async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob
  const bmp = await createImageBitmap(blob)
  const cv = document.createElement('canvas')
  cv.width = bmp.width
  cv.height = bmp.height
  cv.getContext('2d')!.drawImage(bmp, 0, 0)
  return await new Promise<Blob>((resolve) => cv.toBlob((b) => resolve(b!), 'image/png'))
}

function downloadImage(src: string, kind: Kind): void {
  const a = document.createElement('a')
  a.href = src
  a.download = `${kind === 'formula' ? 'formula' : 'figure'}-${Date.now()}.${src.includes('image/jpeg') ? 'jpg' : 'png'}`
  a.click()
}

/* ── AI 解释弹卡 ─────────────────────── */

async function explain(src: string, kind: Kind, anchor: HTMLElement): Promise<void> {
  const pop = $('#explain-pop')
  const body = $('#explain-body')
  if (!pop || !body) return
  pop.hidden = false
  body.innerHTML = '<span class="exp-loading">AI 正在阅读…</span>'
  placeNear(pop, anchor)
  try {
    const text = await window.paperlite.explainImage(src, kind)
    body.textContent = text || '（没有返回内容）'
    placeNear(pop, anchor)
  } catch (err) {
    // 去掉 Electron IPC 包装前缀，只留可读的服务端消息
    let msg = err instanceof Error ? err.message : String(err)
    msg = msg.replace(/^Error:\s*/, '').replace(/Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')
    body.innerHTML = `<span class="exp-error">${msg.replace(/</g, '&lt;').slice(0, 220)}</span>`
  }
}

function placeNear(pop: HTMLElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect()
  const pr = pop.getBoundingClientRect()
  const left = Math.min(Math.max(8, r.right - pr.width), window.innerWidth - pr.width - 8)
  let top = r.bottom + 8
  if (top + pr.height > window.innerHeight - 8) top = Math.max(8, r.top - pr.height - 8)
  pop.style.left = `${left}px`
  pop.style.top = `${top}px`
}

let toastTimer = 0
function toast(msg: string): void {
  const chip = $('#trans-status')
  const text = $('#trans-status-text')
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

/* ── 灯箱（与 settings 模块共用同一个 #lightbox） ── */
export function openLightbox(src: string, alt = ''): void {
  const box = $('#lightbox')
  const img = $('#lightbox-img') as HTMLImageElement | null
  if (!box || !img) return
  img.src = src
  img.alt = alt
  img.classList.remove('actual')
  box.hidden = false
}

export function initMediaTools(): void {
  const article = $('#reflow-article')
  if (!article) return

  const tryDecorate = (el: HTMLElement | null): void => {
    if (!el) return
    const img = el.querySelector<HTMLImageElement>('img')
    if (!img || !img.src) return
    const kind: Kind = el.classList.contains('formula') ? 'formula' : 'figure'
    decorate(el, img, kind)
  }

  // pointerover 冒泡到 article：只在首次进入某个媒体块时注入按钮
  article.addEventListener('pointerover', (e) => {
    const t = e.target as HTMLElement
    const host = t.closest<HTMLElement>('.formula, figure')
    if (host) tryDecorate(host)
  })

  // 图片异步插入（图/表/公式都是后台挂载）→ 挂载后再补一次
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (!(n instanceof HTMLElement)) continue
        if (n.tagName === 'IMG') tryDecorate(n.closest<HTMLElement>('.formula, figure'))
        else n.querySelectorAll('img').forEach((im) => tryDecorate(im.closest<HTMLElement>('.formula, figure')))
      }
    }
  })
  mo.observe(article, { childList: true, subtree: true })

  $('#explain-close')?.addEventListener('click', () => {
    const pop = $('#explain-pop')
    if (pop) pop.hidden = true
  })
  document.addEventListener('keydown', (e) => {
    const pop = $('#explain-pop')
    if (e.key === 'Escape' && pop && !pop.hidden) pop.hidden = true
  })
}
