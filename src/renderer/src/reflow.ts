/**
 * Reflow 引擎 v3：文本 → 行 → 列 → 段落/标题/公式 + 图片提取 + 上下标标记。
 *
 * 管线：pdf.js 文本项 → 行重建（基线聚类 + 列边界切分 + sub/sup 标记）
 *   → 图片提取（算子流 CTM 追踪 + 整页渲染裁剪，仅浏览器环境）
 *   → 双栏检测 → 阅读排序 → 段落合并 → 标题识别 → 页眉页脚过滤
 *
 * 本文件保持纯函数、不触碰 DOM（图片提取按 typeof document 守卫），可在 Node 中单测。
 */
import type { PDFDocumentProxy } from 'pdfjs-dist'

export interface ReflowBlock {
  kind: 'heading' | 'paragraph' | 'formula' | 'image'
  /** heading 级别：1 = 最大字号 */
  level?: number
  /** 来源 PDF 页码（1 起） */
  page: number
  /** 纯文本（测试/翻译用） */
  text: string
  /** 带 sub/sup 标记的安全 HTML（渲染用），仅文本块有 */
  html?: string
  /** 图片块：裁剪出的 dataURL */
  images?: string[]
  /** 公式块：页面上的源区域（pt，y 自页顶向下），用于裁图送 LLM 识别 LaTeX */
  rect?: { x0: number; x1: number; y0: number; y1: number }
}

interface RawTextItem {
  str: string
  transform: number[]
  width: number
  height: number
  fontName?: string
}

/** getTextContent 返回的字体表：fontName → { fontFamily } */
type FontStyles = Record<string, { fontFamily?: string }>

/** 嵌入式数学字体（Computer Modern / MathType / AMS / 符号字库）的典型命名 */
const MATH_FONT_RE =
  /CM(MI|MR|SY|EX|TI|B|ITT|CAL|RMI|MIB|SSI)|MSA[MY]?|MSB[MX]?|Lasy|Symbol|MathType|MT(MI|SY|EX|EXTRA|EXB|MIIT|MITE)|Eurom|Euclid|RSFS|StMary|TXMI|PXMI|wasy|Line[10]|CMBX|LMTT.*Math/i

function isMathFontFamily(family: string | undefined): boolean {
  if (!family) return false
  return MATH_FONT_RE.test(family)
}

/** 数学字符区段：运算符、箭头、数学字母数字符号、希腊字母（工程文献中希腊字母≈数学）
 *  注意必须带 u 标志：U+1D400 超越 BMP，无 u 标志时 \u 只取 4 位会把区间拆烂 */
const MATH_CHAR_RE = /[\u2200-\u22FF\u2190-\u21FF\u2A00-\u2AFF\u{1D400}-\u{1D7FF}\u0370-\u03FF]/u

/** 内容启发式：非空白字符中数学字符占比 ≥ 0.25 判为数学片段（字体名不可用时的兜底） */
function looksLikeMathText(text: string): boolean {
  const chars = text.replace(/\s/g, '')
  if (chars.length < 2) return false
  let math = 0
  for (const ch of chars) if (MATH_CHAR_RE.test(ch)) math++
  return math / chars.length >= 0.25
}

interface Frag {
  x: number
  /** 基线 y（PDF 坐标，自下而上） */
  y: number
  w: number
  fontSize: number
  text: string
  isMath: boolean
}

interface Line {
  page: number
  /** 距页顶的距离（pt） */
  yTop: number
  x0: number
  x1: number
  fontSize: number
  text: string
  /** 数学字体字符的宽度占比 */
  mathRatio: number
  /** 数学 Unicode 字符数占非空白字符比 */
  charMathRatio: number
  /** ≤2 字符的碎片占比（排版公式常被导出为逐符号碎片） */
  shortFragRatio: number
  fragCount: number
  /** 行尾是否带公式编号，如 "(12)" */
  eqNumbered: boolean
  /** 渲染用安全 HTML（含 sub/sup） */
  html: string
  /** 图片行：裁剪 dataURL */
  image?: string
}

const PAGE_NUMBER_RE = /^\s*(page\s*\d+|–?\s*\d+\s*–?|-\s*\d+\s*-)\s*$/i

function escapeHtmlStr(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const s = [...nums].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/** 同一基线组内拼接。plain 用于 text（测试/翻译），html 额外把上下标包成 <sub>/<sup> */
function joinFrags(frags: Frag[]): { text: string; html: string } {
  const sorted = [...frags].sort((a, b) => a.x - b.x)
  const mainSize = median(sorted.map((f) => f.fontSize)) || 10
  // 主基线：按宽度加权取 y（正文行 y 占大头，上下标偏移不干扰）
  const yWeight = new Map<number, number>()
  for (const f of sorted) yWeight.set(f.y, (yWeight.get(f.y) ?? 0) + f.w)
  const mainY = [...yWeight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? sorted[0].y

  let text = ''
  let html = ''
  let prevEnd = Number.NEGATIVE_INFINITY
  let mode: 'sub' | 'sup' | null = null
  const closeTag = (): void => {
    if (mode === 'sub') html += '</sub>'
    if (mode === 'sup') html += '</sup>'
    mode = null
  }
  for (const f of sorted) {
    const needSpace =
      text !== '' &&
      (f.x - prevEnd > Math.max(1, 0.22 * f.fontSize) &&
        (/[A-Za-z0-9,.;:?!)\]]$/.test(text) || /^[A-Za-z0-9(]/.test(f.text)) ||
        (text !== '' && f.x - prevEnd > 2 * f.fontSize))
    const space = needSpace ? ' ' : ''
    text += space + f.text

    const isSmall = f.fontSize < mainSize * 0.8
    const role: 'sub' | 'sup' | null = isSmall
      ? f.y < mainY - mainSize * 0.12
        ? 'sub'
        : f.y > mainY + mainSize * 0.12
          ? 'sup'
          : null
      : null
    if (role !== mode) {
      closeTag()
      if (role === 'sub') html += '<sub>'
      if (role === 'sup') html += '<sup>'
      mode = role
    }
    html += space + escapeHtmlStr(f.text)
    prevEnd = f.x + f.w
  }
  closeTag()
  return { text: text.replace(/\s+/g, ' ').trim(), html: html.trim() }
}

/** 基线聚类：把文本项组装成行（同一基线 ± 容差，容差覆盖上下标偏移），再按列边界/栏间距切分 */
function fragsToLines(frags: Frag[], pageHeight: number, page: number): Line[] {
  // 页级列起点：全部文本项 x0 聚类（相邻差 > 30 断开），用于识别栏/边栏边界
  const starts: number[] = []
  let curMax = Number.NEGATIVE_INFINITY
  for (const x of frags.map((f) => f.x).sort((a, b) => a - b)) {
    if (x - curMax > 30) starts.push(x)
    curMax = Math.max(curMax, x)
  }
  const colIndexOf = (x: number): number => {
    let k = 0
    for (let i = 0; i < starts.length; i++) if (x >= starts[i] - 5) k = i
    return k
  }

  const sorted = [...frags].sort((a, b) => b.y - a.y || a.x - b.x)
  const groups: Frag[][] = []
  let cur: Frag[] = []
  let curY = Number.NaN
  for (const f of sorted) {
    // 容差略放宽：把上下标（偏移约 0.4×字号）并入主行，公式才完整
    const tol = Math.max(2, 0.45 * f.fontSize)
    if (cur.length === 0 || Math.abs(f.y - curY) <= tol) {
      cur.push(f)
      if (cur.length === 1) curY = f.y
    } else {
      groups.push(cur)
      cur = [f]
      curY = f.y
    }
  }
  if (cur.length) groups.push(cur)

  const lines: Line[] = []
  for (const g of groups) {
    // 同一基线上，按列边界与栏间距拆分（双栏论文的栏间距 >> 词间距）
    const byX = [...g].sort((a, b) => a.x - b.x)
    const subgroups: Frag[][] = []
    let sub: Frag[] = []
    let prevEnd = Number.NEGATIVE_INFINITY
    let subCol = -1
    for (const f of byX) {
      const gutter = Math.max(12, 2.2 * f.fontSize)
      const col = colIndexOf(f.x)
      if (sub.length > 0 && (f.x - prevEnd > gutter || (starts.length > 1 && col !== subCol))) {
        subgroups.push(sub)
        sub = []
      }
      sub.push(f)
      if (sub.length === 1) subCol = col
      prevEnd = f.x + f.w
    }
    if (sub.length) subgroups.push(sub)

    for (const sg of subgroups) {
      const joined = joinFrags(sg)
      const text = joined.text
      if (!text) continue
      // 丢弃纯符号碎片行（孤立上下标/连接符，如 ′′−），无任何字母数字且极短
      if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(text) && text.replace(/\s/g, '').length <= 6) continue
      const fontSize = median(sg.map((f) => f.fontSize))
      const totalW = sg.reduce((n, f) => n + f.w, 0)
      const mathW = sg.reduce((n, f) => n + (f.isMath ? f.w : 0), 0)
      const chars = text.replace(/\s/g, '')
      let mathChars = 0
      for (const ch of chars) if (MATH_CHAR_RE.test(ch)) mathChars++
      const shortFrags = sg.filter((f) => f.text.trim().length <= 2).length
      lines.push({
        page,
        yTop: pageHeight - Math.max(...sg.map((f) => f.y)),
        x0: Math.min(...sg.map((f) => f.x)),
        x1: Math.max(...sg.map((f) => f.x + f.w)),
        fontSize,
        mathRatio: totalW > 0 ? mathW / totalW : 0,
        charMathRatio: chars.length > 0 ? mathChars / chars.length : 0,
        shortFragRatio: sg.length > 0 ? shortFrags / sg.length : 0,
        fragCount: sg.length,
        eqNumbered: /\(\s*\d+\s*\)\s*$/.test(text),
        text,
        html: joined.html
      })
    }
  }
  return lines
}

/**
 * 列簇分析 + 双栏检测 + 阅读排序。
 * 1) 行按 x0 聚成文本列簇；平均行宽极窄的簇（如 IEEE 首页作者边栏）判为边栏，
 *    从正文流剔除、独立排在该页末尾。
 * 2) 剩余行做双栏判定：跨中线整行占比低且左右两侧都有足量行 → 左栏后右栏。
 */
function orderLines(lines: Line[], pageWidth: number): Line[] {
  const topDown = (a: Line, b: Line) => a.yTop - b.yTop || a.x0 - b.x0
  const body = [...lines].sort(topDown)
  if (body.length < 6) return body

  // 行 x0 聚类成列簇（相邻 x0 差距过大则断开）
  const byX0 = [...body].sort((a, b) => a.x0 - b.x0)
  const clusters: { lines: Line[]; x0max: number }[] = []
  for (const l of byX0) {
    const last = clusters[clusters.length - 1]
    if (!last || l.x0 - last.x0max > 30) clusters.push({ lines: [l], x0max: l.x0 })
    else {
      last.lines.push(l)
      last.x0max = Math.max(last.x0max, l.x0)
    }
  }

  // 边栏簇：平均行宽 < 15% 页宽（正文行通常 > 20%）；图片行不参与边栏判定
  const avgW = (ls: Line[]) => ls.reduce((n, l) => n + (l.x1 - l.x0), 0) / ls.length
  const isSidebar = (ls: Line[]) => avgW(ls) < pageWidth * 0.15 && ls.length >= 3

  const main: Line[] = []
  const sidebar: Line[] = []
  for (const c of clusters) (isSidebar(c.lines) ? sidebar : main).push(...c.lines)
  const mainSorted = main.sort(topDown)

  const mid = pageWidth / 2
  const gutter = pageWidth * 0.02
  const spanning = mainSorted.filter((l) => l.x0 < mid - gutter && l.x1 > mid + gutter)
  if (spanning.length >= mainSorted.length * 0.25) {
    return [...mainSorted, ...sidebar.sort(topDown)] // 大量整行 → 单栏
  }

  const left = mainSorted.filter((l) => l.x1 <= mid + gutter)
  const right = mainSorted.filter((l) => l.x0 >= mid - gutter && l.x1 > mid + gutter)
  if (
    left.length >= 3 &&
    right.length >= 3 &&
    left.length + right.length >= mainSorted.length * 0.8
  ) {
    return [...left.sort(topDown), ...right.sort(topDown), ...sidebar.sort(topDown)]
  }
  return [...mainSorted, ...sidebar.sort(topDown)]
}

function levelFor(size: number, bodySize: number): number {
  const ratio = size / bodySize
  if (ratio >= 1.7) return 1
  if (ratio >= 1.35) return 2
  return 3
}

/** 重复出现的页眉/页脚行：出现在多数页的页顶/页底短行 */
function dropRunningHeads(perPage: { lines: Line[]; height: number }[]): Line[][] {
  const pageCount = perPage.length
  if (pageCount < 3) return perPage.map((p) => p.lines)

  const headCount = new Map<string, number>()
  for (const { lines, height } of perPage) {
    const edge = [...lines]
      .filter((l) => l.yTop < height * 0.07 || l.yTop > height * 0.93)
      .map((l) => l.text.trim())
    for (const t of new Set(edge)) headCount.set(t, (headCount.get(t) ?? 0) + 1)
  }
  const repeated = new Set(
    [...headCount.entries()]
      .filter(([, c]) => c >= Math.max(3, Math.ceil(pageCount * 0.5)))
      .map(([t]) => t)
  )

  return perPage.map(({ lines }) =>
    lines.filter((l) => !repeated.has(l.text.trim()) && !PAGE_NUMBER_RE.test(l.text))
  )
}

/** 行是公式吗：字体占比 / 符号密度 / 公式编号 / 逐符号碎片结构，任一强信号即判定 */
function isFormulaLine(l: Line): boolean {
  if (l.text.replace(/\s/g, '').length < 1) return false
  if (l.mathRatio >= 0.5) return true
  if (l.charMathRatio >= 0.25) return true
  if (l.eqNumbered && l.charMathRatio >= 0.02) return true
  return l.charMathRatio >= 0.08 && l.shortFragRatio >= 0.65 && l.fragCount >= 6
}

/** 行流 → 语义块（标题/段落/公式/图片） */
function linesToBlocks(lines: Line[], bodySize: number): ReflowBlock[] {
  const blocks: ReflowBlock[] = []
  const isHeadingSize = (s: number) => s > bodySize * 1.18 && s >= 11.5

  let bufT: string[] = []
  let bufH: string[] = []
  let bufPage = 1
  let bufKind: 'heading' | 'paragraph' | 'formula' = 'paragraph'
  let bufLevel = 0
  let bufImages: string[] = []
  let bufLines: Line[] = []

  const flush = (): void => {
    if (bufImages.length > 0) {
      blocks.push({ kind: 'image', page: bufPage, text: '', images: bufImages })
      bufImages = []
    }
    if (bufT.length === 0) {
      bufLines = []
      return
    }
    const text = bufT.join(' ').replace(/\s+/g, ' ').trim()
    const html = bufH.join(' ')
    if (text) {
      const block: ReflowBlock =
        bufKind === 'heading'
          ? { kind: 'heading', level: bufLevel, page: bufPage, text }
          : { kind: bufKind, page: bufPage, text }
      if (bufKind !== 'formula' || /<[a-z]/i.test(html)) block.html = html
      if (bufKind === 'formula' && bufLines.length > 0) {
        block.rect = {
          x0: Math.min(...bufLines.map((l) => l.x0)),
          x1: Math.max(...bufLines.map((l) => l.x1)),
          y0: Math.min(...bufLines.map((l) => l.yTop)),
          y1: Math.max(...bufLines.map((l) => l.yTop + Math.max(l.fontSize, 6)))
        }
      }
      blocks.push(block)
    }
    bufT = []
    bufH = []
    bufLines = []
  }

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]

    if (l.image) {
      // 连续图片行（同一张图被拆成多张）合并进一个图片块
      if (bufImages.length === 0) flush()
      bufImages.push(l.image)
      bufPage = l.page
      continue
    }

    const heading = isHeadingSize(l.fontSize) && !isFormulaLine(l)
    const kind: 'heading' | 'paragraph' | 'formula' = isFormulaLine(l)
      ? 'formula'
      : heading
        ? 'heading'
        : 'paragraph'

    // 拉丁连字符换行：同一个单词，直接拼进缓冲区末元素（join 时才不会多出空格）
    const lastT = bufT[bufT.length - 1] ?? ''
    if (
      bufT.length > 0 &&
      bufKind !== 'formula' &&
      /[-\u2010]$/.test(lastT) &&
      /^[a-z]/.test(l.text)
    ) {
      const stripped = lastT.replace(/[-\u2010]$/, '')
      bufT[bufT.length - 1] = stripped + l.text
      bufH[bufH.length - 1] = (bufH[bufH.length - 1] ?? '').replace(/[-\u2010]<\/(sub|sup)>$/, '') +
        l.html.replace(/^<(sub|sup)>/, '')
      continue
    }

    let brk = bufT.length === 0 || kind !== bufKind
    if (!brk && lines[i - 1]) {
      const prev = lines[i - 1]
      const vGap = l.yTop - prev.yTop - prev.fontSize
      if (vGap > bodySize * 0.55) brk = true // 段间距
      // 首行缩进（1~4.5em 内的右移）；更大的 x0 跳变是换栏，不构成分段
      const dx = l.x0 - prev.x0
      if (dx > bodySize * 1.6 && dx < bodySize * 4.5) brk = true
    }

    if (brk && (bufT.length > 0 || bufImages.length > 0)) flush()
    if (bufT.length === 0) {
      bufPage = l.page
      bufKind = kind
      bufLevel = heading ? levelFor(l.fontSize, bodySize) : 0
      bufLines = []
    }
    bufT.push(l.text)
    bufH.push(l.html)
    bufLines.push(l)
  }
  flush()

  // 收尾：把 ≤4 词的碎片段落并入前一段落（同页、同为正文；保留 "2)" 式列表项）
  const merged: ReflowBlock[] = []
  for (const b of blocks) {
    const prev = merged[merged.length - 1]
    const words = b.text.split(/\s+/).filter(Boolean).length
    if (
      prev &&
      b.kind === 'paragraph' &&
      prev.kind === 'paragraph' &&
      b.page === prev.page &&
      words <= 4 &&
      !/^\d+\)/.test(b.text)
    ) {
      prev.text = `${prev.text} ${b.text}`.replace(/\s+/g, ' ')
      prev.html = `${prev.html ?? prev.text} ${b.html ?? b.text}`
    } else {
      merged.push(b)
    }
  }
  return merged
}

/* ── 图片提取：追踪算子流 CTM 得到图片矩形，整页渲染后裁剪 ── */

interface ImgRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** 从算子流解析图片放置矩形（PDF 用户空间）。ops 来自 page.getOperatorList() */
export function extractImageRects(
  fnArray: number[],
  argsArray: unknown[][],
  opsConsts: { save: number; restore: number; transform: number; paintImageXObject: number; paintInlineImageXObject: number }
): ImgRect[] {
  const rects: ImgRect[] = []
  let ctm: number[] = [1, 0, 0, 1, 0, 0]
  const stack: number[][] = []
  const apply = (m: number[]): void => {
    // pdf.js transform: 新矩阵在左侧 => ctm = m × ctm
    ctm = [
      m[0] * ctm[0] + m[1] * ctm[2],
      m[0] * ctm[1] + m[1] * ctm[3],
      m[2] * ctm[0] + m[3] * ctm[2],
      m[2] * ctm[1] + m[3] * ctm[3],
      m[4] * ctm[0] + m[5] * ctm[2] + ctm[4],
      m[4] * ctm[1] + m[5] * ctm[3] + ctm[5]
    ]
  }
  const px = (x: number, y: number): [number, number] => [
    ctm[0] * x + ctm[2] * y + ctm[4],
    ctm[1] * x + ctm[3] * y + ctm[5]
  ]
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    if (fn === opsConsts.save) stack.push([...ctm])
    else if (fn === opsConsts.restore) ctm = stack.pop() ?? ctm
    else if (fn === opsConsts.transform) apply(argsArray[i] as number[])
    else if (fn === opsConsts.paintImageXObject || fn === opsConsts.paintInlineImageXObject) {
      // 图片绘制在单位方形 [0,1]×[0,1] 上，被 CTM 变换到页面
      const pts = [px(0, 0), px(1, 0), px(0, 1), px(1, 1)]
      const xs = pts.map((p) => p[0])
      const ys = pts.map((p) => p[1])
      rects.push({
        x0: Math.min(...xs),
        y0: Math.min(...ys),
        x1: Math.max(...xs),
        y1: Math.max(...ys)
      })
    }
  }
  return rects
}

/** 浏览器环境：整页渲染后按矩形裁剪出图片 dataURL */
async function cropPageImages(
  page: import('pdfjs-dist').PDFPageProxy,
  viewportW: number,
  viewportH: number
): Promise<Line[]> {
  if (typeof document === 'undefined') return []
  const { OPS } = await import('pdfjs-dist')
  const opList = await page.getOperatorList()
  const rects = extractImageRects(opList.fnArray, opList.argsArray as unknown[][], {
    save: OPS.save,
    restore: OPS.restore,
    transform: OPS.transform,
    paintImageXObject: OPS.paintImageXObject,
    paintInlineImageXObject: OPS.paintInlineImageXObject
  })
  if (rects.length === 0) return []

  const scale = Math.min(2, 1100 / viewportW)
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return []
  await page.render({ canvasContext: ctx, viewport }).promise

  const lines: Line[] = []
  for (const r of rects) {
    const w = r.x1 - r.x0
    const h = r.y1 - r.y0
    if (w < 30 || h < 30) continue // 装饰性小图
    if (w * h > viewportW * viewportH * 0.92) continue // 整页背景/水印
    const sx = r.x0 * scale
    const sy = (viewportH - r.y1) * scale
    const sw = w * scale
    const sh = h * scale
    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.floor(sw))
    out.height = Math.max(1, Math.floor(sh))
    const octx = out.getContext('2d')
    if (!octx) continue
    // 白底，避免透明图裁出黑块
    octx.fillStyle = '#fff'
    octx.fillRect(0, 0, out.width, out.height)
    octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height)
    lines.push({
      page: 0,
      yTop: viewportH - r.y1,
      x0: r.x0,
      x1: r.x1,
      fontSize: 0,
      text: '',
      html: '',
      mathRatio: 0,
      charMathRatio: 0,
      shortFragRatio: 0,
      fragCount: 1,
      eqNumbered: false,
      image: out.toDataURL('image/jpeg', 0.85)
    })
  }
  return lines
}

/** 主入口：整本 PDF → 重排语义块序列 */
export async function extractReflowBlocks(doc: PDFDocumentProxy): Promise<ReflowBlock[]> {
  const perPage: { lines: Line[]; height: number; width: number }[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const vp = page.getViewport({ scale: 1 })
    const tc = await page.getTextContent()
    const styles = (tc.styles ?? {}) as unknown as FontStyles
    const frags: Frag[] = []
    for (const raw of tc.items as unknown[]) {
      const it = raw as RawTextItem
      if (typeof it.str !== 'string' || !it.str.trim() || !it.transform) continue
      const t = it.transform
      const fontSize = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]) || it.height || 10
      const fam = it.fontName ? styles[it.fontName]?.fontFamily : undefined
      frags.push({
        x: t[4],
        y: t[5],
        w: it.width || 0,
        fontSize,
        text: it.str,
        isMath: isMathFontFamily(fam) || looksLikeMathText(it.str)
      })
    }
    const lines = fragsToLines(frags, vp.height, p)
    // 图片行（仅浏览器；Node 单测跳过）
    try {
      const imgLines = await cropPageImages(page, vp.width, vp.height)
      for (const il of imgLines) il.page = p
      lines.push(...imgLines)
    } catch (err) {
      console.warn('[paperlite] 图片提取失败（忽略）', err)
    }
    perPage.push({ lines, height: vp.height, width: vp.width })
  }

  const kept = dropRunningHeads(perPage)
  const bodySize = median(
    perPage
      .flatMap((p) => p.lines)
      .filter((l) => !l.image)
      .map((l) => l.fontSize)
      .sort((a, b) => a - b)
      .slice(0, Math.max(1, Math.floor(perPage.reduce((n, p) => n + p.lines.length, 0) / 2)))
  )

  const ordered: Line[] = []
  perPage.forEach((p, i) => {
    ordered.push(...orderLines(kept[i], p.width))
  })
  return linesToBlocks(ordered, bodySize)
}
