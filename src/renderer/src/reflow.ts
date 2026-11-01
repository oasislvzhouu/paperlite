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
  /** 块首行距页顶位置（pt），供图片异步插入时对位 */
  top?: number
  /** 元数据角色：首页结构化 + 全文图注 */
  role?: 'title' | 'authors' | 'affiliation' | 'abstract' | 'keywords' | 'meta' | 'caption' | 'list-item' | 'para-cont'
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

export interface Line {
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

/** 版权/授权样板文字（出版社首页边栏/页脚，不属于正文内容） */
const COPYRIGHT_LINE_RE =
  /rights\/index\.html|all rights reserved|authorized licensed use|personal use is permitted|requires IEEE permission|^\s*\d{4}-\d{3,5}[XS]?\s?©|©\s*\d{4}\s+(IEEE|Elsevier|Springer|The Author|by Elsevier)|ieee\.org\/publications|downloaded from (ieee )?xplore|版权所有|未经.{0,10}许可.{0,10}(转载|翻印|复制)/i

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

/** 同一基线组内拼接。plain 用于 text（测试/翻译），html 额外把上下标包成 <sub>/<sup>、首字下沉包 <span class="dc"> */
function joinFrags(frags: Frag[]): { text: string; html: string } {
  const sorted = [...frags].sort((a, b) => a.x - b.x)
  // 主字号：按字符数加权（抗 drop cap 离群——29.6pt 的 "B" 只占 1 字符）
  const totalChars = sorted.reduce((n, f) => n + Math.max(1, f.text.length), 0)
  const weighted =
    sorted.reduce((n, f) => n + f.fontSize * Math.max(1, f.text.length), 0) / Math.max(1, totalChars)
  const mainSize = weighted > 0 ? weighted : 10
  const isDropCap = (f: Frag): boolean => f.fontSize > mainSize * 2 && f.text.trim().length <= 2
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

    if (isDropCap(f)) {
      closeTag()
      html += `${space}<span class="dc">${escapeHtmlStr(f.text)}</span>`
      prevEnd = f.x + f.w
      continue
    }
    const isSmall = f.fontSize < mainSize * 0.8 && f.fontSize > mainSize * 0.3
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
  let groupMax = 0
  for (const f of sorted) {
    // 容差：下标并入主行需要 0.45×主字号（但整体封顶 6pt，
    // 否则大字号行（如 18pt 标题）的容差会把下一行（作者行）也吸进来）
    const tol = Math.max(2, 0.45 * f.fontSize, Math.min(0.45 * groupMax, 6))
    if (cur.length === 0 || Math.abs(f.y - curY) <= tol) {
      cur.push(f)
      if (cur.length === 1) curY = f.y
      groupMax = Math.max(groupMax, f.fontSize)
    } else {
      groups.push(cur)
      cur = [f]
      curY = f.y
      groupMax = f.fontSize
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
      // 行字号按字符数加权（抗 drop cap：29.6pt 的单字符不应抬高整行字号）
      const wChars = sg.reduce((n, f) => n + Math.max(1, f.text.length), 0)
      const fontSize =
        sg.reduce((n, f) => n + f.fontSize * Math.max(1, f.text.length), 0) / Math.max(1, wChars) ||
        median(sg.map((f) => f.fontSize))
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
export function orderLines(lines: Line[], pageWidth: number): Line[] {
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
  const isSpanning = (l: Line): boolean => l.x0 < mid - gutter && l.x1 > mid + gutter
  const spanning = mainSorted.filter(isSpanning)
  if (spanning.length >= mainSorted.length * 0.25) {
    return [...mainSorted, ...sidebar.sort(topDown)] // 大量整行 → 单栏
  }

  // 跨栏行（标题/作者/通栏图表）不能进 left/right——此前它们会被双栏判定直接丢弃
  const rest = mainSorted.filter((l) => !isSpanning(l))
  const left = rest.filter((l) => l.x1 <= mid + gutter)
  const right = rest.filter((l) => l.x0 >= mid - gutter && l.x1 > mid + gutter)
  if (left.length >= 3 && right.length >= 3 && left.length + right.length >= rest.length * 0.8) {
    return [
      ...spanning.sort(topDown),
      ...left.sort(topDown),
      ...right.sort(topDown),
      ...sidebar.sort(topDown)
    ]
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
  // 算法伪代码的输入/变量声明（如 "Budget, θ, θ−, ER memory"）：
  // 含 2 个以上长英文单词 → 是名词列表不是公式
  const longWords = l.text.match(/[A-Za-z]{4,}/g) ?? []
  if (longWords.length >= 2) return false
  if (l.mathRatio >= 0.5) return true
  if (l.charMathRatio >= 0.25) return true
  if (l.eqNumbered && l.charMathRatio >= 0.02) return true
  return l.charMathRatio >= 0.08 && l.shortFragRatio >= 0.65 && l.fragCount >= 6
}

/** 文本模式章节标题：罗马数字/字母编号（"I. INTRODUCTION"、"A. Pseudo-Label"），
 *  IEEE/Elsevier 小写大写章节标题字号与正文相同，字号启发式抓不到 */
const SECTION_HEADING_RE = /^(?:[IVXLC]{1,5}|[A-Z])\.\s+\S+/
function isSectionHeadingLine(l: Line): boolean {
  if (l.text.length > 80) return false
  if (!SECTION_HEADING_RE.test(l.text.trim())) return false
  // 全大写或首字母大写的短标题，排除普通句子行（句子一般更长且含小写词开头后接逗号等）
  const words = l.text.trim().split(/\s+/)
  if (words.length > 12) return false
  return /^[A-Z]/.test(l.text.trim())
}

/** 全文行间隙统计：返回最常见行间隙（近似排版行距） */
function estimateLeading(lines: Line[], bodySize: number): number {
  const buckets = new Map<number, number>()
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1]
    const l = lines[i]
    if (!prev.fontSize || !l.fontSize) continue
    if (prev.page !== l.page) continue
    // 仅统计同栏（x0 接近）的连续行，排除跨栏跳变
    if (Math.abs(l.x0 - prev.x0) > bodySize * 1.2) continue
    const gap = l.yTop - prev.yTop - prev.fontSize
    if (gap <= 0 || gap > bodySize * 2) continue
    const key = Math.round(gap / (bodySize * 0.08))
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  let bestKey = -1
  let bestCount = 0
  for (const [k, c] of buckets) {
    if (c > bestCount) {
      bestCount = c
      bestKey = k
    }
  }
  if (bestKey < 0) return bodySize * 0.2 // 兜底：常见默认行距
  return bestKey * bodySize * 0.08 + bodySize * 0.04
}

const LIST_ITEM_RE = /^\(?([0-9]{1,2}|[a-zA-Z])[).]\s+\S/

/** 行流 → 语义块（标题/段落/公式/图片） */
function linesToBlocks(lines: Line[], bodySize: number): ReflowBlock[] {
  // 自适应段距阈值：实际行距（众数）+ 30% 余量；下限 0.35×字号防过敏
  const paraGap = Math.max(bodySize * 0.35, estimateLeading(lines, bodySize) + bodySize * 0.3)
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
      if (bufLines[0]) block.top = bufLines[0].yTop
      if (block.kind === 'paragraph' && LIST_ITEM_RE.test(text.trim()) && text.length < 160 && !/^([IVXLC]{1,5})\./.test(text.trim())) block.role = 'list-item'
      blocks.push(block)
    }
    bufT = []
    bufH = []
    bufLines = []
  }

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]

    // 孤儿上下标碎片：整行都是小字号（公式的下标散件，如 7pt 的 "t"/"u trn"）且极短
    // → 直接并入前一块（公式块的 rect 也会随之包含它），不独立成段
    const tinyDebris =
      l.fontSize > 0 &&
      l.fontSize < bodySize * 0.8 &&
      l.text.replace(/\s/g, '').length <= 12 &&
      !l.eqNumbered
    if (tinyDebris && bufT.length > 0 && bufKind !== 'heading') {
      bufT.push(l.text)
      bufH.push(l.html)
      bufLines.push(l)
      continue
    }

    if (l.image) {
      // 连续图片行（同一张图被拆成多张）合并进一个图片块
      if (bufImages.length === 0) flush()
      bufImages.push(l.image)
      bufPage = l.page
      continue
    }

    const heading =
      !isFormulaLine(l) && (isHeadingSize(l.fontSize) || isSectionHeadingLine(l))
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

    // 列表项：每项独立成块
    const isListItem = kind === 'paragraph' && LIST_ITEM_RE.test(l.text.trim()) && l.text.length < 160

    let brk = bufT.length === 0 || kind !== bufKind || isListItem
    if (!brk && lines[i - 1]) {
      const prev = lines[i - 1]
      const vGap = l.yTop - prev.yTop - prev.fontSize
      if (vGap > paraGap) brk = true // 段间距（自适应阈值）
      // 首行缩进（1~4.5em 内的右移）；更大的 x0 跳变是换栏，不构成分段
      const dx = l.x0 - prev.x0
      if (dx > bodySize * 1.6 && dx < bodySize * 4.5) brk = true
    }

    if (brk && (bufT.length > 0 || bufImages.length > 0)) flush()
    if (bufT.length === 0) {
      bufPage = l.page
      bufKind = kind
      bufLevel = heading
        ? isSectionHeadingLine(l)
          ? /^[IVXLC]/.test(l.text.trim())
            ? 2
            : 3
          : levelFor(l.fontSize, bodySize)
        : 0
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

/** 浏览器环境：整页渲染后按矩形裁剪出图片 dataURL（导出给阅读器渐进插入用） */
/** pdf.js 算子码（由调用方传入，避免本模块二次 import pdfjs-dist 造成双实例） */
export interface PdfOpsCodes {
  save: number
  restore: number
  transform: number
  paintImageXObject: number
  paintInlineImageXObject: number
}

export async function cropPageImages(
  page: import('pdfjs-dist').PDFPageProxy,
  viewportW: number,
  viewportH: number,
  ops: PdfOpsCodes
): Promise<Line[]> {
  if (typeof document === 'undefined') return []
  // 顺序关键：先 render 再 getOperatorList。反序（oplist→render）会在真 worker 上
  // 把同页 render 悬死（v4 intent 状态互锁），这是此前图片消失的根因
  const scale = Math.min(3, 2000 / viewportW)
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return []
  // 单次渲染带超时（不 cancel——cancel 会毒化 v4 intentState 导致后续 render 永久挂起；
  // 超时则丢弃任务引用，换新 canvas 重试）
  const tryRender = async (timeoutMs: number): Promise<boolean> => {
    try {
      await Promise.race([
        page.render({ canvasContext: ctx, viewport }).promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('render-timeout')), timeoutMs))
      ])
      return true
    } catch {
      return false
    }
  }
  if (!(await tryRender(4000))) {
    await new Promise((r) => setTimeout(r, 5000))
    if (!(await tryRender(8000))) {
      const g4 = globalThis as { __plImgRenderErr?: Record<number, string> }
      g4.__plImgRenderErr = {
        ...(g4.__plImgRenderErr ?? {}),
        [page.pageNumber]: 'render-timeout (retried, no-cancel)'
      }
      return []
    }
  }

  const g = globalThis as { __plImgRects?: Record<number, number>; __plImgErr?: Record<number, string> }
  const opList = await page.getOperatorList().catch((e: unknown) => {
    g.__plImgErr = { ...(g.__plImgErr ?? {}), [page.pageNumber]: String(e) }
    return null
  })
  if (!opList) return []
  const rects = extractImageRects(opList.fnArray, opList.argsArray as unknown[][], ops)
  g.__plImgRects = { ...(g.__plImgRects ?? {}), [page.pageNumber]: rects.length }
  if (rects.length === 0) return []

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
      image: out.toDataURL('image/jpeg', 0.92)
    })
  }
  const g2 = globalThis as { __plImgLines?: Record<number, number> }
  g2.__plImgLines = { ...(g2.__plImgLines ?? {}), [page.pageNumber]: lines.length }
  return lines
}

/** 调试导出：单页行重建结果（诊断排版问题用） */
export function debugLinesForPage(page: {
  getTextContent: () => Promise<{ items: unknown[]; styles?: unknown }>
  getViewport: (o: { scale: number }) => { width: number; height: number }
}): Promise<Line[]> {
  return page.getTextContent().then((tc) => {
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
    const vp = page.getViewport({ scale: 1 })
    return fragsToLines(frags, vp.height, 0)
  })
}

/** 首页元数据结构化：识别标题/作者区/摘要/关键词并打角色标签 */
function structureFirstPage(blocks: ReflowBlock[]): void {
  const absIdx = blocks.findIndex((b) => b.page === 1 && /^abstract\s*[—–-]/i.test(b.text.trim()))
  if (absIdx === -1) return
  blocks[absIdx].role = 'abstract'
  for (let i = absIdx + 1; i < Math.min(absIdx + 4, blocks.length); i++) {
    if (/^index terms\s*[—–-]/i.test(blocks[i].text.trim())) {
      blocks[i].role = 'keywords'
      break
    }
  }
  // 标题：摘要之前的开头连续 heading 块，合并为一个 role=title 的 h1
  let titleStart = -1
  let titleEnd = -1
  for (let i = 0; i < absIdx; i++) {
    if (blocks[i].kind === 'heading' && blocks[i].page === 1) {
      if (titleStart === -1) titleStart = i
      titleEnd = i
    } else if (titleStart !== -1) {
      break
    }
  }
  if (titleStart !== -1) {
    const texts: string[] = []
    const htmls: string[] = []
    for (let i = titleStart; i <= titleEnd; i++) {
      texts.push(blocks[i].text)
      htmls.push(blocks[i].html ?? blocks[i].text)
    }
    blocks.splice(
      titleStart,
      titleEnd - titleStart + 1,
      {
        kind: 'heading',
        level: 1,
        page: 1,
        role: 'title',
        text: texts.join(' ').replace(/\s+/g, ' '),
        html: htmls.join(' ')
      }
    )
  }
  // 标题与摘要之间的正文段 → 作者名 / 单位机构 / 版权碎块降级 meta
  const AFFILIATION_RE =
    /university|institute|department|college|laboratory|school of|dept\.|academy|@[a-z0-9.-]+\.(com|edu|cn|org)|\b(?:beijing|shanghai|nanjing|xi'?an|wuhan|changsha|harbin|hangzhou|hunan|guangdong|china)\b|中国|大学|学院|研究院|实验室/i
  const newAbsIdx = blocks.findIndex((b) => b.role === 'abstract')
  for (let i = 0; i < newAbsIdx; i++) {
    if (blocks[i].page === 1 && blocks[i].kind === 'paragraph' && !blocks[i].role) {
      if (/©|all rights reserved|licensed use|doi|http/i.test(blocks[i].text)) {
        blocks[i].role = 'meta'
      } else if (AFFILIATION_RE.test(blocks[i].text) && !/member, ieee/i.test(blocks[i].text)) {
        blocks[i].role = 'affiliation'
      } else {
        blocks[i].role = 'authors'
      }
    }
  }
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
    const lines = fragsToLines(frags, vp.height, p).filter(
      (l) => !COPYRIGHT_LINE_RE.test(l.text)
    )
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
  const blocks = linesToBlocks(ordered, bodySize)
  structureFirstPage(blocks)
  markFormulaContinuation(blocks)
  markCaptions(blocks)
  return blocks
}

/** 公式后的续接句（"where W denotes…"）不打段前空隙，视觉上延续前段 */
const CONT_SENT_RE = /^(where|here|and|but|so|thus|then|such|in which|其中|式中|其中，)|[a-z]/i
function markFormulaContinuation(blocks: ReflowBlock[]): void {
  for (let i = 2; i < blocks.length; i++) {
    const a = blocks[i - 2]
    const f = blocks[i - 1]
    const b = blocks[i]
    if (
      a.kind === 'paragraph' &&
      f.kind === 'formula' &&
      b.kind === 'paragraph' &&
      !b.role &&
      CONT_SENT_RE.test(b.text.trim()) &&
      b.page === a.page
    ) {
      b.role = 'para-cont'
    }
  }
}

/** 图题/表题识别（"Fig. 1. xxx"、"图2 xxx"、"TABLE II"）→ caption 角色 */
const CAPTION_RE = /^\s*(fig\.?|figure|图|表|table)\s*\d+\s*[.、:：)）,，-]?/i
function markCaptions(blocks: ReflowBlock[]): void {
  for (const b of blocks) {
    if (b.kind === 'paragraph' && !b.role && b.text.length < 350 && CAPTION_RE.test(b.text)) {
      b.role = 'caption'
    }
  }
}
