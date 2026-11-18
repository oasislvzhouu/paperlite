/**
 * 阅读设置：主题 / 字体 / 字号 / 行高 / 译文样式。
 * 对标 Scholaread 的阅读层设计令牌（--srd-*）：深色 #121212 系、
 * 浅色 #fff/#fafafa 系、护眼暖纸 #f4efe6 + #ad8e70 主色。
 * 设置存 localStorage，对所有文献生效。
 */

export type Theme = 'dark' | 'light' | 'sepia'
export type FontKey =
  | 'ebgaramond'
  | 'libertine'
  | 'lato'
  | 'opensans'
  | 'serif'
  | 'cambria'
  | 'sans'
  | 'song'
export type TransStyle = 'underline' | 'block'

export interface ReadSettings {
  theme: Theme
  font: FontKey
  /** 正文字号 px */
  size: number
  /** 正文行高 */
  lh: number
  /** 译文呈现：下划线（Scholaread 风）/ 色块 */
  trans: TransStyle
}

const KEY = 'pl.read.settings.v1'

const DEFAULTS: ReadSettings = {
  theme: 'dark',
  font: 'ebgaramond',
  size: 17,
  lh: 1.75,
  trans: 'block'
}

/** 字体栈：前四项为随包开源字体（EB Garamond / Linux Libertine / Lato /
 *  Open Sans），后四项为系统字体。拉丁字形由随包字体渲染，中文回退到
 *  宋体/思源宋体等系统字体。 */
const FONTS: Record<FontKey, string> = {
  ebgaramond: "'EB Garamond', Georgia, 'Songti SC', SimSun, serif",
  libertine: "'Linux Libertine', 'EB Garamond', Georgia, 'Songti SC', SimSun, serif",
  lato: "Lato, 'Segoe UI', system-ui, 'Microsoft YaHei', sans-serif",
  opensans: "'Open Sans', 'Segoe UI', system-ui, 'Microsoft YaHei', sans-serif",
  serif: "Georgia, 'Times New Roman', 'Songti SC', SimSun, serif",
  cambria: "Cambria, 'Sitka Text', 'Palatino Linotype', Georgia, serif",
  sans: "'Segoe UI', system-ui, -apple-system, 'Microsoft YaHei', sans-serif",
  song: "'Source Han Serif SC', 'Noto Serif SC', 'Songti SC', SimSun, 'Times New Roman', serif"
}

let state: ReadSettings = { ...DEFAULTS }

export function getSettings(): ReadSettings {
  return state
}

function read(): ReadSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const p = JSON.parse(raw) as Partial<ReadSettings>
    return {
      theme: p.theme === 'light' || p.theme === 'sepia' ? p.theme : 'dark',
      font: p.font && p.font in FONTS ? p.font : DEFAULTS.font,
      size: typeof p.size === 'number' ? Math.min(28, Math.max(13, p.size)) : DEFAULTS.size,
      lh: typeof p.lh === 'number' ? Math.min(2.2, Math.max(1.3, p.lh)) : DEFAULTS.lh,
      trans: p.trans === 'underline' ? 'underline' : 'block'
    }
  } catch {
    return { ...DEFAULTS }
  }
}

/** 把设置写到 DOM（html[data-theme] + 阅读区 CSS 变量） */
export function applySettings(): void {
  const root = document.documentElement
  root.dataset.theme = state.theme
  const article = document.querySelector<HTMLElement>('#reflow-article')
  if (article) {
    article.style.setProperty('--reflow-font', `${state.size}px`)
    article.style.setProperty('--read-lh', String(state.lh))
    article.style.setProperty('--font-article', FONTS[state.font])
    article.dataset.transStyle = state.trans
  }
}

export function updateSettings(patch: Partial<ReadSettings>): ReadSettings {
  state = { ...state, ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* 隐私模式等场景忽略 */
  }
  applySettings()
  syncPanel()
  return state
}

/** 面板控件与当前状态同步 */
export function syncPanel(): void {
  const seg = (id: string, v: string): void => {
    document.querySelectorAll<HTMLButtonElement>(`#${id} button`).forEach((b) => {
      b.classList.toggle('on', b.dataset.v === v)
    })
  }
  seg('rs-theme', state.theme)
  seg('rs-trans', state.trans)
  const fontSel = document.querySelector<HTMLSelectElement>('#rs-font')
  if (fontSel) fontSel.value = state.font
  const size = document.querySelector<HTMLInputElement>('#rs-size')
  const sizeVal = document.querySelector<HTMLElement>('#rs-size-val')
  if (size) size.value = String(state.size)
  if (sizeVal) sizeVal.textContent = String(state.size)
  const lh = document.querySelector<HTMLInputElement>('#rs-lh')
  const lhVal = document.querySelector<HTMLElement>('#rs-lh-val')
  if (lh) lh.value = String(state.lh)
  if (lhVal) lhVal.textContent = state.lh.toFixed(2)
}

/** 绑定设置面板与灯箱事件（幂等：只调用一次） */
export function initReadPrefs(): void {
  state = read()
  applySettings()
  syncPanel()

  const panel = document.querySelector<HTMLElement>('#read-settings')
  const sbtn = document.querySelector<HTMLElement>('#settings-btn')
  sbtn?.addEventListener('click', () => {
    if (!panel) return
    panel.hidden = !panel.hidden
    sbtn.classList.toggle('toggle-on', !panel.hidden)
  })
  // 点面板外部关闭
  document.addEventListener('click', (e) => {
    if (!panel || panel.hidden) return
    const t = e.target as Node
    if (panel.contains(t) || sbtn?.contains(t)) return
    panel.hidden = true
    sbtn?.classList.remove('toggle-on')
  })

  document.querySelectorAll<HTMLButtonElement>('#rs-theme button').forEach((b) => {
    b.addEventListener('click', () => updateSettings({ theme: b.dataset.v as Theme }))
  })
  document.querySelector('#rs-font')?.addEventListener('change', (e) => {
    updateSettings({ font: (e.target as HTMLSelectElement).value as FontKey })
  })
  document.querySelectorAll<HTMLButtonElement>('#rs-trans button').forEach((b) => {
    b.addEventListener('click', () => updateSettings({ trans: b.dataset.v as TransStyle }))
  })
  const size = document.querySelector<HTMLInputElement>('#rs-size')
  size?.addEventListener('input', () => updateSettings({ size: Number(size.value) }))
  const lh = document.querySelector<HTMLInputElement>('#rs-lh')
  lh?.addEventListener('input', () => updateSettings({ lh: Number(lh.value) }))

  initLightbox()
}

/* ── 灯箱：图表 / 公式 / 表格点开放大（对标 Scholaread 的 cursor: zoom-in） ── */

function initLightbox(): void {
  const box = document.querySelector<HTMLElement>('#lightbox')
  const img = document.querySelector<HTMLImageElement>('#lightbox-img')
  if (!box || !img) return

  const open = (src: string, alt: string): void => {
    img.src = src
    img.alt = alt
    box.hidden = false
    // 点开后允许「再点一下放大到原始像素」的切换
    img.classList.remove('actual')
  }
  const close = (): void => {
    box.hidden = true
    img.src = ''
  }

  document.querySelector('#reflow-article')?.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest('img')
    if (!el) return
    const host = el.closest('.formula, figure')
    if (!host) return
    const src = (el as HTMLImageElement).src
    if (src) open(src, (el as HTMLImageElement).alt || '')
  })
  img.addEventListener('click', (e) => {
    e.stopPropagation()
    img.classList.toggle('actual')
  })
  box.addEventListener('click', close)
  document.querySelector('#lightbox-close')?.addEventListener('click', (e) => {
    e.stopPropagation()
    close()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !box.hidden) close()
  })
}
