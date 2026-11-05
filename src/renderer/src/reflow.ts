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
  kind: 'heading' | 'paragraph' | 'formula' | 'image' | 'table'
  /** LLM 整页解析产出的公式 LaTeX（渲染层直接 KaTeX） */
  latex?: string | 'table'
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
  /** 首行字号（脚注检测用） */
  firstFontSize?: number
  /** 元数据角色：首页结构化 + 全文图注 + 算法框原子块 + 参考文献条目 */
  role?:
    | 'title'
    | 'authors'
    | 'affiliation'
    | 'abstract'
    | 'keywords'
    | 'meta'
    | 'caption'
    | 'list-item'
    | 'para-cont'
    | 'algorithm'
    | 'ref-entry'
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
  /** 表格区域：该行为表注，附带整表渲染矩形（top-down pt） */
  tableZone?: { x0: number; x1: number; y0: number; y1: number }
  /** tableZone 实为算法框（"Algorithm N" + 伪代码体）→ 块 role=algorithm */
  tableAlgo?: boolean
  /** 参考文献标题行（居中排版偏离栏锚会被排到栏尾）→ 强制起新块 */
  isRefStart?: boolean
  /** 编号锚定的公式行（display 公式的碎片主体/编号行） */
  eqCollect?: boolean
  /** 编号行的公式区（整栏宽 × 上下正文行之间），KaTeX 裁图用 */
  eqZone?: { x0: number; x1: number; y0: number; y1: number }
}

const PAGE_NUMBER_RE = /^\s*(page\s*\d+|–?\s*\d+\s*–?|-\s*\d+\s*-)\s*$/i

/** 版权/授权样板文字（出版社首页边栏/页脚，不属于正文内容） */
const COPYRIGHT_LINE_RE =
  /rights\/index\.html|all rights reserved|authorized licensed use|personal use is permitted|requires IEEE permission|index\.html for more information|^\s*\d{4}-\d{3,5}[XS]?\s?©|©\s*\d{4}\s+(IEEE|Elsevier|Springer|The Author|by Elsevier)|ieee\.org\/publications|downloaded from (ieee )?xplore|版权所有|未经.{0,10}许可.{0,10}(转载|翻印|复制)/i

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

  // 两阶段列锚：① frag 级宽候选（合并组会把右栏 frags 记到左桶，
  // 组级统计会自我强化地丢锚——见第 2 页 starts=[35] 案例）；
  // ② 组级验证：真锚必有多条行的行首落在其 ±6 内（行内公式
  // 碎片的假锚只被 1-2 条行使用，淘汰）
  const starts: number[] = []
  {
      const cand: number[] = []
    const buckets = new Map<number, number>()
    for (const f of frags) {
      const k = Math.floor(f.x / 10)
      buckets.set(k, (buckets.get(k) ?? 0) + 1)
    }
    const fThreshold = Math.max(3, groups.length * 0.12)
    // 评分制：全部桶按密度出候选 → 按 frag 支持数降序贪心选间距 ≥90 的锚。
    // 旧"先到先得+间距"会让假候选（公式碎片桶）占位挡掉真锚（第 2 页 275 挡 315）
    const scored: Array<{ x: number; uses: number }> = []
    for (const k of [...buckets.keys()].sort((a, b) => a - b)) {
      const self = buckets.get(k) ?? 0
      const c = (buckets.get(k - 1) ?? 0) + self + (buckets.get(k + 1) ?? 0)
      if (c >= fThreshold && self >= fThreshold * 0.5) {
        const x = k * 10 + 5
        let uses = 0
        for (const f of frags) {
          if (f.x >= x - 8 && f.x <= x + 8) uses++
        }
        if (uses >= Math.max(8, frags.length * 0.012)) scored.push({ x, uses })
      }
    }
    scored.sort((a, b) => b.uses - a.uses)
    for (const s2 of scored) {
      if (starts.every((x) => Math.abs(s2.x - x) >= 90)) starts.push(s2.x)
    }
    starts.sort((a, b) => a - b)
  }
  const colIndexOf = (x: number): number => {
    let k = 0
    for (let i = 0; i < starts.length; i++) if (x >= starts[i] - 6) k = i
    return k
  }

  const lines: Line[] = []
  for (const g of groups) {
    const gSize = median(g.map((f) => f.fontSize))
    const gSpan = Math.max(...g.map((f) => f.x + f.w)) - Math.min(...g.map((f) => f.x))
    // 跨栏标题行整行保留，不做列切分——否则标题被拦腰切断。
    // 两类特征：大字号宽行；全大写行（IEEE small caps 标题字号与正文相近）
    const gText0 = g.map((f) => f.text).join('')
    const letters0 = gText0.replace(/[^A-Za-z]/g, '')
    const upperRatio =
      letters0.length >= 6
        ? [...letters0].filter((c) => c === c.toUpperCase()).length / letters0.length
        : 0
    const isWideHeading =
      (gSize >= 13 && gSpan > 150) || (upperRatio >= 0.85 && gSpan > 140)
    // 同一基线上，按列边界与栏间距拆分（双栏论文的栏间距 >> 词间距）
    const byX = [...g].sort((a, b) => a.x - b.x)
    const subgroups: Frag[][] = []
    let sub: Frag[] = []
    let prevEnd = Number.NEGATIVE_INFINITY
    let subCol = -1
    for (const f of byX) {
      const gutter = Math.max(12, 2.2 * f.fontSize)
      const col = colIndexOf(f.x)
      if (
        sub.length > 0 &&
        !isWideHeading &&
        (f.x - prevEnd > gutter || (starts.length > 1 && col !== subCol))
      ) {
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
  // 跨栏居中的窄公式行（display equation）：不是双栏证据，
  // 参与统计会让跨栏公式多的页面误回退单栏（第 2 页交错根因）
  const isNarrowFormula = (l: Line): boolean => {
    const w = l.x1 - l.x0
    return w < pageWidth * 0.6 && (l.mathRatio >= 0.3 || l.charMathRatio >= 0.1 || l.fragCount >= 5)
  }
  const realSpanning = mainSorted.filter((l) => isSpanning(l) && !isNarrowFormula(l))
  const midFormulas = mainSorted.filter((l) => isSpanning(l) && isNarrowFormula(l))
  if (realSpanning.length >= mainSorted.length * 0.25) {
    return [...mainSorted, ...sidebar.sort(topDown)] // 大量整行 → 单栏
  }

  // 跨栏行（标题/作者/通栏图表）不能进 left/right——此前它们会被双栏判定直接丢弃
  // 分类必须互斥完备：右栏短行（x0≥mid 但 x1≤mid+gutter，如公式编号）
  // 曾同时不满足两个判据掉出集合，令 left+right<80% 误回退单栏
  const rest = mainSorted.filter((l) => !isSpanning(l))
  const left = rest.filter((l) => l.x1 <= mid)
  const right = rest.filter((l) => l.x1 > mid)
  // 窄公式行按几何中心归入所在栏
  for (const l of midFormulas) {
    ;((l.x0 + l.x1) / 2 < mid + gutter ? left : right).push(l)
  }
  if (left.length >= 3 && right.length >= 3 && left.length + right.length >= rest.length * 0.8) {
    return [
      ...realSpanning.sort(topDown),
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
export function dropRunningHeads(perPage: { lines: Line[]; height: number }[]): Line[][] {
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
      .filter(([, c]) => c >= Math.max(3, Math.ceil(pageCount * 0.35)))
      .map(([t]) => t)
  )

  return perPage.map(({ lines }) =>
    lines.filter((l) => !repeated.has(l.text.trim()) && !PAGE_NUMBER_RE.test(l.text))
  )
}

/** 行是公式吗：字体占比 / 符号密度 / 公式编号 / 逐符号碎片结构，任一强信号即判定 */
/** 数学函数/记号名（不算"英文散文词"） */
const MATH_WORD_RE =
  /^(sigma|tanh|exp|max|min|log|arg|sample|softmax|sigmoid|relu|concat|softplus|where|and|then|follows|respectively)$/i

function isFormulaLine(l: Line): boolean {
  if (l.text.replace(/\s/g, '').length < 1) return false
  const t = l.text.trim()
  // 强信号 1：行尾公式编号 (N) 且散文词≤1 —— display 公式的特征
  const proseWords = (t.match(/[A-Za-z]{4,}/g) ?? []).filter((w) => !MATH_WORD_RE.test(w))
  const hasEqNum = /\(\d{1,2}\)\s*$/.test(t)
  if (hasEqNum && proseWords.length <= 1) return true
  // 强信号 2：含等号、短行、几乎无散文词 —— 纯表达式行
  const eqCount = (t.match(/=/g) ?? []).length
  if (eqCount >= 1 && t.length <= 90 && proseWords.length <= 1) return true
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
export function estimateLeading(lines: Line[], bodySize: number): number {
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
export function linesToBlocks(lines: Line[], bodySize: number): ReflowBlock[] {
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
        // 编号行的整栏公式区优先（覆盖主体行+上下标散件+编号），裁图完整
        const zone = bufLines.find((l) => l.eqZone)?.eqZone
        block.rect = zone ?? {
          x0: Math.min(...bufLines.map((l) => l.x0)),
          x1: Math.max(...bufLines.map((l) => l.x1)),
          y0: Math.min(...bufLines.map((l) => l.yTop)),
          y1: Math.max(...bufLines.map((l) => l.yTop + Math.max(l.fontSize, 6)))
        }
      }
      if (bufLines[0]) {
        block.top = bufLines[0].yTop
        block.firstFontSize = bufLines[0].fontSize
      }
      if (block.kind === 'paragraph' && LIST_ITEM_RE.test(text.trim()) && text.length < 160 && !/^([IVXLC]{1,5})\./.test(text.trim())) block.role = 'list-item'
      blocks.push(block)
    }
    bufT = []
    bufH = []
    bufLines = []
  }

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]

    // 孤立碎片（内容判据，不依赖字号——MuPDF 的 bbox.h 与正文接近：
    // ① 极短无标点孤立行（"t"、"u trn"）② 含希腊/数学符号的短行
    // （"L(πθ), the optimization of L(πθ)"）→ 并入前块
    const stripped = l.text.replace(/\s/g, '')
    const isOrphanShort =
      !l.eqNumbered &&
      stripped.length <= 3 &&
      /^[A-Za-z]$/.test(stripped)
    const isGreekShort =
      !l.eqNumbered &&
      l.text.length <= 60 &&
      /[\u0370-\u03FF]/.test(l.text) &&
      (l.text.match(/[A-Za-z]{4,}/g) ?? []).length <= 3
    const tinyDebris = isOrphanShort || isGreekShort
    // 公式块后的小字号行：display 公式的下标散件，无条件并入（字号是强证据）。
    // 不进 bufLines——公式 rect 保持主体行范围，避免 LLM 裁图混入碎片段
    if (
      bufKind === 'formula' &&
      bufT.length > 0 &&
      l.fontSize > 0 &&
      l.fontSize < bodySize * 0.85 &&
      !l.eqNumbered
    ) {
      bufT.push(l.text)
      bufH.push(l.html)
      continue
    }
    if (tinyDebris && bufT.length > 0 && l.text.replace(/\s/g, '').length <= 12) {
      bufT.push(l.text)
      bufH.push(l.html)
      continue
    }

    if (l.isRefStart) flush() // REFERENCES 标题强制起新块（防并入前段尾部）

    if (l.tableZone) {
      flush()
      blocks.push({
        kind: 'table',
        role: l.tableAlgo ? 'algorithm' : undefined,
        page: l.page,
        text: l.text.replace(/\s+/g, ' ').trim(),
        rect: l.tableZone,
        top: l.yTop
      })
      continue
    }

    if (l.image) {
      // 连续图片行（同一张图被拆成多张）合并进一个图片块
      if (bufImages.length === 0) flush()
      bufImages.push(l.image)
      bufPage = l.page
      continue
    }

    // 公式优先：含等号/数学符号/Greek 的行即使 bbox 偏大（上下标撑高）也不是标题。
    // 典型误判："optimal policy θopt = arg max" 曾被当作大标题
    const looksMathy =
      /[=⊕∘∇]/.test(l.text) || /[\u0370-\u03FF]/.test(l.text) || l.eqNumbered
    const headingEligible =
      !isFormulaLine(l) && !l.eqCollect && !looksMathy
    const heading =
      headingEligible && (isHeadingSize(l.fontSize) || isSectionHeadingLine(l))
    const kind: 'heading' | 'paragraph' | 'formula' =
      l.eqCollect || isFormulaLine(l)
        ? 'formula'
        : heading
          ? 'heading'
          : 'paragraph'

    // 孤立公式编号行（"(1)"）：紧跟公式块或编号行的并入前块

    if (bufKind === 'formula' && bufT.length > 0 && /^\(\d{1,2}\)$/.test(l.text.trim())) {
      bufT.push(l.text)
      bufH.push(l.html)
      bufLines.push(l)
      continue
    }

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
      !/^\d+\)/.test(b.text) &&
      // REFERENCES 标题块（1 词）不能并回前段——参考文献区的起点标记
      !REFERENCES_HEADING_RE.test(b.text.trim())
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
  opsConsts: { save: number; restore: number; transform: number; paintImageXObject: number; paintInlineImageXObject: number },
  pageW = 612,
  pageH = 792
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
      const rect = {
        x0: Math.min(...xs),
        y0: Math.min(...ys),
        x1: Math.max(...xs),
        y1: Math.max(...ys)
      }
      // clamp 到页面范围：越界放置的图片对象（如 y1 超出页高）会
      // 污染聚类包围盒与裁剪区域，导致图表显示巨大且错乱
      rects.push({
        x0: Math.max(0, rect.x0),
        y0: Math.max(0, rect.y0),
        x1: Math.min(pageW, rect.x1),
        y1: Math.min(pageH, rect.y1)
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
  const rects = extractImageRects(opList.fnArray, opList.argsArray as unknown[][], ops, viewportW, viewportH)
  g.__plImgRects = { ...(g.__plImgRects ?? {}), [page.pageNumber]: rects.length }
  if (rects.length === 0) return []

  const lines: Line[] = []
  // 聚类合并：一幅图常由多个图片对象拼成（如网络结构图的部件、分层条带），
  // 间距 <16pt 的矩形归拢为一个包围盒整裁，否则会碎成十几张碎图
  const clusters: ImgRect[] = rects.map((r) => ({ ...r }))
  let merged = true
  while (merged) {
    merged = false
    outer: for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        const m = clusters[a]
        const r = clusters[b]
        if (r.x0 <= m.x1 + 28 && r.x1 >= m.x0 - 28 && r.y0 <= m.y1 + 28 && r.y1 >= m.y0 - 16) {
          m.x0 = Math.min(m.x0, r.x0)
          m.x1 = Math.max(m.x1, r.x1)
          m.y0 = Math.min(m.y0, r.y0)
          m.y1 = Math.max(m.y1, r.y1)
          clusters.splice(b, 1)
          merged = true
          break outer
        }
      }
    }
  }

  for (const r of clusters) {
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
export interface MupdfPageLike {
  toStructuredText: () => { asJSON: () => string }
  getBounds: () => number[]
}

/** MuPDF 提取层：原生行分组（精确字形定位）→ Line[]，行质量远高于
 *  pdf.js getTextContent 的碎片输出；下游管线（列锚/段落/标题/表注/
 *  公式 KaTeX/图片裁剪）全部复用 */
export async function extractReflowBlocksMupdf(pages: MupdfPageLike[]): Promise<ReflowBlock[]> {
  const perPage: { lines: Line[]; height: number; width: number }[] = []
  for (let p = 0; p < pages.length; p++) {
    const stext = JSON.parse(pages[p].toStructuredText().asJSON())
    // 图表内部标签微小块（宽 <45pt 的真文本，如 Fig.3 的 "Xincep="/"6664"）：
    // 页内 ≥4 个时视为图表标签群，整组跳过（图片裁剪已含视觉信息）
    const tinyBlocks = stext.blocks.filter(
      (b: { type: string; bbox: { w: number }; lines?: Array<{ text?: string }> }) => b.type === 'text' && b.bbox.w < 45 && (b.lines ?? []).every((l: { text?: string }) => (l.text ?? '').length <= 30)
    )
    const skipTiny = tinyBlocks.length >= 4 ? new Set(tinyBlocks) : null
    const lines: Line[] = []
    for (const block of stext.blocks) {
      if (skipTiny?.has(block)) continue
      for (const l of block.lines ?? []) {
        const text = (l.text ?? '').replace(/\s+/g, ' ').trim()
        if (!text) continue
        const bb = l.bbox
        const words: string[] = text.split(/\s+/).filter(Boolean)
        const shortWords = words.filter((w: string) => w.replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, '').length <= 1).length
        let mathChars = 0
        for (const ch of text.replace(/\s/g, '')) {
          if (/[\u2200-\u22FF\u2190-\u21FF\u2A00-\u2AFF\u{1D400}-\u{1D7FF}\u0370-\u03FF]/u.test(ch)) mathChars++
        }
        const chars = text.replace(/\s/g, '')
        lines.push({
          page: p + 1,
          yTop: bb.y,
          x0: bb.x,
          x1: bb.x + bb.w,
          fontSize: bb.h,
          text,
          html: text.replace(/[&<>"]/g, (c: string) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c])),
          mathRatio: 0,
          charMathRatio: chars.length ? mathChars / chars.length : 0,
          shortFragRatio: words.length ? shortWords / words.length : 0,
          fragCount: words.length,
          eqNumbered: /\(\s*\d+\s*\)\s*$/.test(text)
        })
      }
    }
    const bounds = pages[p].getBounds()
    perPage.push({ lines, height: bounds[3] - bounds[1], width: bounds[2] - bounds[0] })
  }

  const kept = dropRunningHeads(perPage)
  const bodyLines = perPage.flatMap((p) => p.lines).filter((l) => !l.image)
  const bodySize =
    median(
      bodyLines
        .map((l) => l.fontSize)
        .sort((a, b) => a - b)
        .slice(0, Math.max(1, Math.floor(bodyLines.length / 2)))
    ) || 10

  const ordered: Line[] = []
  perPage.forEach((p, i) => ordered.push(...orderLines(kept[i], p.width)))
  reorderReferenceHeading(ordered)
  detectTableZones(ordered, bodySize)
  detectAlgorithms(ordered, bodySize)
  const blocks = linesToBlocks(ordered, bodySize)
  mergeFormulaClusters(blocks, bodySize)
  mergeOrphanFragments(blocks)
  structureFirstPage(blocks)
  demoteFootnotes(blocks, bodySize)
  mergeFormulaDebris(blocks, bodySize)
  markFormulaContinuation(blocks)
  markCaptions(blocks)
  markReferences(blocks)
  return blocks
}

/** 孤立碎片块归并（块级后处理）：极短无标点行 / 含希腊符号且散文词≤3 的
 *  短段，与相邻块垂直间距 ≤20pt 时并入（优先前一块以保留公式类型） */
function mergeOrphanFragments(blocks: ReflowBlock[]): void {
  const isOrphan = (b: ReflowBlock): boolean => {
    if (b.kind !== 'paragraph' || b.role) return false
    const t = b.text.trim()
    if (t.length === 0 || t.length > 70) return false
    if (/^[A-Za-z]$/.test(t)) return true
    const prose = (t.match(/[A-Za-z]{4,}/g) ?? []).filter((w) => !MATH_WORD_RE.test(w))
    return /[\u0370-\u03FF=⊕∘∇]/.test(t) && prose.length <= 3
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (!isOrphan(b)) continue
    const prev = blocks[i - 1]
    const next = blocks[i + 1]
    // 含运算符的碎片（公式残件）允许更大间距（段距级 ~45pt），
    // 纯单字母碎片仍用紧阈值（20pt）
    const hasOp = /[=←⊕∘∇]/.test(b.text)
    const limit = hasOp ? 45 : 20
    const closeTo = (x: ReflowBlock | undefined): boolean =>
      !!x &&
      x.page === b.page &&
      x.top !== undefined &&
      b.top !== undefined &&
      Math.abs(b.top - x.top) <= limit
    if (prev && prev.kind !== 'image' && closeTo(prev)) {
      prev.text = `${prev.text} ${b.text}`.replace(/\s+/g, ' ').trim()
      if (b.html) prev.html = `${prev.html ?? ''} ${b.html}`.trim()
      blocks.splice(i, 1)
      continue
    }
    if (next && next.kind !== 'image' && closeTo(next)) {
      next.text = `${b.text} ${next.text}`.replace(/\s+/g, ' ').trim()
      if (b.html) next.html = `${b.html ?? ''} ${next.html ?? ''}`.trim()
      blocks.splice(i, 1)
    }
  }
}

/** 相邻公式碎片块聚类：同栏垂直间距 ≤18pt 的 formula 块/短碎片段
 *  归并为一个公式块（多行 display 公式被行聚类拆散的修复）。
 *  gap > 18pt 视为独立元素（段距/独立公式），不合并 */


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
    const ol = orderLines(kept[i], p.width)
    // 行间浮动公式碎片：挤在两正文行行距里的短数学行（display 公式
    // 前后有段距不触发），按 y 排序会插在上一行和下一行之间造成交错，
    // 延迟到下一正文行之后才符合阅读顺序
    for (let k = 0; k < ol.length - 1; k++) {
      const l = ol[k]
      const n = ol[k + 1]
      const isFloatMath =
        (l.mathRatio >= 0.4 || l.charMathRatio >= 0.25) && l.text.length < 60 && l.text.trim().length > 0
      const nextIsProse = n.mathRatio < 0.2 && n.charMathRatio < 0.12 && n.text.length > 30
      const tight = n.page === l.page && n.yTop >= l.yTop && n.yTop - l.yTop < Math.max(l.fontSize, 10) * 1.1
      if (isFloatMath && nextIsProse && tight) {
        ;[ol[k], ol[k + 1]] = [ol[k + 1], ol[k]]
        k++ // 跳过换过来的正文行
      }
    }
    ordered.push(...ol)
  })
  // 编号锚定的公式段收集：display 公式常被拆成主体行+编号行+散件行，
  // 编号 (N) 是强锚点——从编号行向上回溯收集紧邻的数学行。
  // IEEE 小型大写章节标题的编号（如 "1) xxx"）不匹配 (N) 模式，不受影响
  for (let i = 0; i < ordered.length; i++) {
    const l = ordered[i]
    const trimmed = l.text.trim()
    const standalone = /^\((\d{1,2})\)$/.test(trimmed)
    const tail = trimmed.match(/^(.{0,70}?)\s*\((\d{1,2})\)\s*$/)
    if (!standalone && !(tail && tail[1].length <= 70 && l.charMathRatio >= 0.04 && l.fragCount >= 2)) continue
    l.eqCollect = true
    // 向上回溯：收集紧邻的数学碎片行
    let j = i - 1
    for (; j >= 0; j--) {
      const prev = ordered[j]
      if (prev.page !== l.page) break
      if (prev.eqCollect) continue
      const gapOk = prev.yTop >= l.yTop - bodySize * 6 && prev.yTop <= l.yTop
      if (!gapOk) break
      const mathy = prev.mathRatio >= 0.25 || prev.charMathRatio >= 0.1 || (prev.shortFragRatio >= 0.5 && prev.fragCount >= 4)
      if (!mathy) break
      prev.eqCollect = true
    }
    // 公式区（zone）：上下正文行之间 × 所在栏宽。LLM 裁图用完整区域，
    // 避免 rect 只含主体行导致裁图缺右半 → 识别出截断 LaTeX。
    // above/below 必须在编号行的视觉上/下方——双栏流里编号行后的下一行
    // 可能是另一栏顶部（yTop 更小），直接用会算出负高度
    const above = j >= 0 && ordered[j].page === l.page && ordered[j].yTop < l.yTop ? ordered[j] : null
    const belowRaw = ordered[i + 1]
    const below =
      belowRaw && belowRaw.page === l.page && belowRaw.yTop > l.yTop ? belowRaw : null
    const colX0 = Math.min(l.x0, above ? above.x0 : l.x0, below ? below.x0 : l.x0)
    const colX1 = Math.max(l.x1, above ? above.x1 : l.x1, below ? below.x1 : l.x1)
    const zone = {
      x0: Math.max(20, colX0 - 6),
      x1: Math.min(592, colX1 + 6),
      y0: above ? above.yTop + above.fontSize : Math.max(0, l.yTop - bodySize * 3),
      y1: below ? below.yTop : Math.min(792, l.yTop + bodySize * 4)
    }
    if (zone.y1 <= zone.y0) {
      zone.y0 = Math.max(0, l.yTop - 2)
      zone.y1 = Math.min(792, l.yTop + l.fontSize + 2)
    }
    l.eqZone = zone
  }

  reorderReferenceHeading(ordered)
  detectTableZones(ordered, bodySize)
  detectAlgorithms(ordered, bodySize)
  const blocks = linesToBlocks(ordered, bodySize)
  mergeFormulaClusters(blocks, bodySize)
  mergeOrphanFragments(blocks)
  structureFirstPage(blocks)
  demoteFootnotes(blocks, bodySize)
  mergeFormulaDebris(blocks, bodySize)
  markFormulaContinuation(blocks)
  markCaptions(blocks)
  markReferences(blocks)
  return blocks
}

/** 相邻公式碎片块聚类：同栏垂直间距 ≤18pt 的 formula 块/短碎片段
 *  归并为一个公式块（多行 display 公式被行聚类拆散的修复）。
 *  gap > 18pt 视为独立元素（段距/独立公式），不合并 */
function mergeFormulaClusters(blocks: ReflowBlock[], bodySize: number): void {
  let i = 1
  while (i < blocks.length) {
    const a = blocks[i - 1]
    const b = blocks[i]
    if (a.top === undefined || b.top === undefined || a.page !== b.page) {
      i++
      continue
    }
    // gap >= 0：同一基线的拆分对（gap=0）与紧邻多行公式（gap≤18）都合并；
    // gap < 0 是阅读序回跳（换栏/换页），不合并
    const gap = b.top - a.top
    if (gap < 0 || gap > 18) {
      i++
      continue
    }
    // 1) formula + formula（同行拆分/紧邻多行公式）→ 拼接
    if (a.kind === 'formula' && b.kind === 'formula') {
      a.text = `${a.text} ${b.text}`.replace(/\s+/g, ' ').trim()
      if (b.html) a.html = `${a.html ?? ''} ${b.html}`.trim()
      if (b.rect && a.rect) {
        a.rect = {
          x0: Math.min(a.rect.x0, b.rect.x0),
          x1: Math.max(a.rect.x1, b.rect.x1),
          y0: Math.min(a.rect.y0, b.rect.y0),
          y1: Math.max(a.rect.y1, b.rect.y1)
        }
      } else if (b.rect) a.rect = b.rect
      blocks.splice(i, 1)
      continue
    }
    // 2) formula + 短碎片段（≤40 字符、非正文、非编号行）→ 并入公式
    if (
      a.kind === 'formula' &&
      b.kind === 'paragraph' &&
      !b.role &&
      b.text.length <= 40 &&
      !/[.!?]$/.test(b.text.trim())
    ) {
      a.text = `${a.text} ${b.text}`.replace(/\s+/g, ' ').trim()
      if (b.html) a.html = `${a.html ?? ''} ${b.html}`.trim()
      blocks.splice(i, 1)
      continue
    }
    i++
  }
}

/** display 公式块后的小字号下标散件段：并回公式块（字号 <0.85×正文为判据） */
function mergeFormulaDebris(blocks: ReflowBlock[], bodySize: number): void {
  const isDebrisPara = (n: ReflowBlock): boolean => {
    // 字号判据可能被断段合并洗掉（碎片与正文行合并后继承正文字号），
    // 用碎片词特征兜底：孤立单字母词（i i i a）占比高的短段是公式散件
    if ((n.firstFontSize ?? bodySize) < bodySize * 0.85) return true
    const words = n.text.split(/\s+/).filter(Boolean)
    const shortWords = words.filter((w) => w.length <= 1).length
    return words.length > 5 && shortWords / words.length >= 0.2
  }
  for (let i = blocks.length - 2; i >= 0; i--) {
    const f = blocks[i]
    if (f.kind !== 'formula') continue
    // 迭代吸收公式后的连续碎片段（可能多条）
    let j = i + 1
    let absorbed = 0
    while (j < blocks.length && blocks[j].kind === 'paragraph' && isDebrisPara(blocks[j])) {
      const n = blocks[j]
      f.text = `${f.text} ${n.text}`.replace(/\s+/g, ' ')
      if (n.html) f.html = `${f.html ?? ''} ${n.html}`
      if (n.rect && f.rect) {
        f.rect = {
          x0: Math.min(f.rect.x0, n.rect.x0),
          x1: Math.max(f.rect.x1, n.rect.x1),
          y0: Math.min(f.rect.y0, n.rect.y0),
          y1: Math.max(f.rect.y1, n.rect.y1)
        }
      }
      absorbed++
      j++
    }
    if (absorbed > 0) blocks.splice(i + 1, absorbed)
  }
  // 兜底：吸收后公式块内仍含孤立单字母词串（跨栏碎片残余），移除
  for (const b of blocks) {
    if (b.kind !== 'formula') continue
    const cleaned = b.text.replace(/(?:\b[a-z]\b\s*){2,}/gi, '')
    b.text = cleaned.replace(/\s+/g, ' ').trim()
  }
}

/** 首页脚注降级：左栏底部基金/作者/DOI 脚注（小字号+特征词）移到页尾，
 *  并合并被脚注隔断的跨栏段落（前块无句号结尾 + 后块小写开头） */
const FOOTNOTE_RE =
  /received\b.*accepted|date of (publication|current version)|this work was supported|corresponding author|are with the (college|school|department)|e-mail:|digital object identifier|©/i

function demoteFootnotes(blocks: ReflowBlock[], bodySize: number): void {
  // 以同页正文块的最大首行字号为基准（bodySize 会被首页小字行拉低，不可靠）
  let maxFfs = bodySize
  for (const b of blocks) {
    if (b.page === 1 && b.kind === 'paragraph' && !b.role && b.firstFontSize) {
      maxFfs = Math.max(maxFfs, b.firstFontSize)
    }
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (
      b.kind !== 'paragraph' ||
      b.role ||
      b.page !== 1 ||
      (b.firstFontSize ?? maxFfs) >= maxFfs * 0.88 ||
      !FOOTNOTE_RE.test(b.text)
    ) {
      continue
    }
    b.role = 'meta'
    // 移到第 1 页块序列末尾
    blocks.splice(i, 1)
    let lastP1 = blocks.length
    for (let j = blocks.length - 1; j >= 0; j--) {
      if (blocks[j].page === 1) {
        lastP1 = j + 1
        break
      }
    }
    blocks.splice(lastP1, 0, b)
  }
  // 合并被脚注隔断的段落：前块不以句号结尾 + 后块小写开头 + 同页。
  // list-item 角色允许合并（列表项标题行 + 续行是一个逻辑段落）
  for (let i = blocks.length - 2; i >= 0; i--) {
    const a = blocks[i]
    const b = blocks[i + 1]
    if (
      a.kind === 'paragraph' &&
      b.kind === 'paragraph' &&
      (!a.role || a.role === 'list-item') &&
      !b.role &&
      a.page === b.page &&
      !/[.!?;:）)"']$/.test(a.text.trim()) &&
      // REFERENCES 标题是全大写，会被 all-caps 续行分支误并入前段尾部
      !REFERENCES_HEADING_RE.test(b.text.trim()) &&
      (/^[a-z(]/.test(b.text.trim()) || /^[A-Z]{2,}/.test(b.text.trim()))
    ) {
      a.text = `${a.text} ${b.text}`.replace(/\s+/g, ' ')
      a.html = `${a.html ?? a.text} ${b.html ?? b.text}`
      blocks.splice(i + 1, 1)
    }
  }
}

/* ── 表格区域识别：表注（TABLE II / 表2，含罗马数字）之后的表格体行
 *    整体渲染为图片块，避免单元格文本被线性化成乱序段落 ── */

const TABLE_CAPTION_RE = /^\s*(table|表)\s*(?:[IVXLC]{1,6}|\d+)\b/i

export function detectTableZones(lines: Line[], bodySize: number): void {
  const isTableRow = (l: Line): boolean => {
    const t = l.text.replace(/\s/g, '')
    if (t.length <= 8) return true // 短单元格
    if (l.fragCount >= 3 && l.text.length < 90) return true // 多列对齐行（限长防吞正文）
    if (t.length < 32 && /\d|[/.]/.test(t)) return true // 数字/斜杠数据行
    return false
  }
  const isProse = (l: Line): boolean =>
    l.text.length > 60 && l.fragCount <= 2 && !TABLE_CAPTION_RE.test(l.text)
  /** 参考文献条目（"[1] D. Xiaobing…" / "REFERENCES"）：绝不属于表格体。
   *  doi/卷期页码行会被"数字/斜杠数据行"判据误收，必须显式排除 */
  const isRefEntry = (l: Line): boolean =>
    /^\[\s*\d{1,3}\s*\]/.test(l.text.trim()) || /^(references?|bibliography|参考文献)\b/i.test(l.text.trim())

  for (let i = 0; i < lines.length; i++) {
    const cap = lines[i]
    if (!cap.tableZone && !TABLE_CAPTION_RE.test(cap.text.trim())) continue
    if (cap.text.trim().length > 130) continue
    // 行内散文提及 "Table V reports the 95% CI of…"：编号后紧跟小写词
    // （动词/介词）的是句中提及；真表注编号后是大写标题词或空（"TABLE II"）
    const afterNum = cap.text.trim().replace(TABLE_CAPTION_RE, '').trim().replace(/^[.:：，,、\-—–]\s*/, '')
    if (/^[a-z]/.test(afterNum)) continue
    // IEEE 算法浮动体："TABLE N" 表注正下方是 "ALGORITHM M" —— 整个
    // 浮动体是伪代码框，交给 detectAlgorithms 原子化（转曲兜底也跳过，
    // 否则会裁出半页误图）
    const nextLine = lines[i + 1]
    if (
      nextLine &&
      nextLine.page === cap.page &&
      !nextLine.tableZone &&
      nextLine.yTop > cap.yTop &&
      ALGO_CAPTION_RE.test(nextLine.text.trim())
    ) {
      continue
    }
    // 收集表注之后同页、yTop 递增、同栏的表格体行
    const rows: Line[] = []
    let j = i + 1
    for (; j < lines.length; j++) {
      const l = lines[j]
      if (l.page !== cap.page) break
      if (l.yTop < cap.yTop - 2) break // 阅读序回跳（换栏）→ 表格不会跨栏
      // 同栏约束：表体行必须与表注有横向重叠（跨栏溢出会把下一栏的
      // 文献条目/短行整片吞进来）
      if (l.x1 < cap.x0 - 40 || l.x0 > cap.x1 + 40) break
      if (isRefEntry(l)) break // 文献条目/REFERENCES 标题即断
      if (isProse(l)) break
      if (!isTableRow(l)) break
      rows.push(l)
    }
    if (rows.length < 2) {
      // 兜底：表格体为转曲矢量（无文本层无图片对象）→ 表注到页底整块渲染。
      // 栏感知：表注明确在单栏内时只裁该栏（US Letter 612pt 双栏中线 ~306）
      const pageH = 792
      const colX0 = cap.x0 >= 306 ? 306 : 20
      const colX1 = cap.x0 >= 306 ? 592 : cap.x1 <= 306 ? 302 : 592
      cap.tableZone = {
        x0: colX0,
        x1: colX1,
        y0: cap.yTop - 2,
        y1: pageH - 26
      }
      continue
    }
    // 表格高度上限（约 320pt）：截断超出的行，防止误吸收正文
    const capRows: Line[] = []
    for (const r of rows) {
      if (r.yTop + (r.fontSize || 8) - cap.yTop > 320) break
      capRows.push(r)
    }
    if (capRows.length >= 2) rows.length = capRows.length
    if (rows.length < 2) continue
    // 表注行与表格体合并为 table 块（带渲染矩形），移除体行
    const all = [cap, ...rows]
    cap.tableZone = {
      x0: Math.min(...all.map((l) => l.x0)),
      x1: Math.max(...all.map((l) => l.x1)),
      y0: Math.min(...all.map((l) => l.yTop)) - 2,
      y1: Math.max(...all.map((l) => l.yTop + Math.max(l.fontSize, 6))) + 2
    }
    lines.splice(i + 1, rows.length)
  }
}

/* ── 算法框原子化（对标 Scholaread no-reflow-code-i）：
 *    "Algorithm N" 表题 + 伪代码体（编号步骤/Input/Output/数学行）整体
 *    裁图渲染。伪代码的缩进层级与符号排版无法文本重建，线性化只会得到
 *    乱序残句；原子块是唯一保真解 ── */

const ALGO_CAPTION_RE = /^\s*algorithm\s*(?:\d{1,3}|[IVXLC]{1,6})\s*[:.·\-—–]?\s*/i

function isAlgoBodyLine(l: Line): boolean {
  const t = l.text.trim()
  if (!t || t.length > 95) return false
  if (ALGO_CAPTION_RE.test(t)) return false // 下一个算法框
  if (CAPTION_RE.test(t) || TABLE_CAPTION_RE.test(t)) return false // 图/表注
  if (/^\s*\d{1,2}\s*[:.)\-]/.test(t)) return true // 编号步骤 "1:" "2)"
  if (
    /^(input|output|requires?|ensures?|given|initialize[ds]?|procedure|return|repeat|while|until|end)\b/i.test(
      t
    ) &&
    t.length < 70
  )
    return true
  if (/[=←→⊕∘∇]/.test(t) || /[\u0370-\u03FF]/.test(t)) return true
  if (l.charMathRatio >= 0.1) return true
  return l.fragCount >= 3 && t.length < 60
}

export function detectAlgorithms(lines: Line[], bodySize: number): void {
  for (let i = 0; i < lines.length; i++) {
    const cap = lines[i]
    if (cap.tableZone || cap.eqCollect) continue
    if (!ALGO_CAPTION_RE.test(cap.text.trim())) continue
    if (cap.text.trim().length > 100) continue
    // 行内散文提及 "Algorithm 1 shows that…"：编号后紧跟小写词即拒绝
    const afterNum = cap.text.trim().replace(ALGO_CAPTION_RE, '').trim().replace(/^[.:：，,、\-—–]\s*/, '')
    if (/^[a-z]/.test(afterNum)) continue
    // 收集表题之后同页、yTop 递增的伪代码体行
    const rows: Line[] = []
    let j = i + 1
    for (; j < lines.length; j++) {
      const l = lines[j]
      if (l.page !== cap.page) break
      if (l.yTop < cap.yTop - 2) break // 阅读序回跳（换栏）
      if (rows.length > 0 && l.yTop - rows[rows.length - 1].yTop > bodySize * 3) break // 框级空隙
      if (!isAlgoBodyLine(l)) break
      if (l.yTop + (l.fontSize || 8) - cap.yTop > 300) break // 高度上限
      rows.push(l)
    }
    // 有效性：≥2 行伪代码才原子化。散文提到 "Algorithm 1 shows…" 的
    // 下文是普通段落，rows 必然不足 → 自动免疫
    // 矢量兜底：伪代码体转曲（无文本层）时 rows 为空，但表题下方同栏
    // 会出现 ≥4 行正文高度的文本空隙 —— 空隙区即伪代码框，裁图到下一
    // 条文本行上沿为止
    if (rows.length < 2) {
      let below: Line | null = null
      for (let k = i + 1; k < lines.length; k++) {
        const x = lines[k]
        if (x.page !== cap.page) break
        if (x.yTop <= cap.yTop) continue
        if (x.x1 < cap.x0 - 40 || x.x0 > cap.x1 + 40) continue // 异栏行不算
        below = x
        break
      }
      const gap = below ? below.yTop - (cap.yTop + Math.max(cap.fontSize, 6)) : 0
      if (!below || gap < bodySize * 4) continue
      const colX0 = cap.x0 >= 306 ? 306 : cap.x1 <= 306 ? 20 : 20
      const colX1 = cap.x0 >= 306 ? 592 : cap.x1 <= 306 ? 302 : 592
      const prevV = lines[i - 1]
      const prevTbl =
        prevV &&
        prevV.page === cap.page &&
        !prevV.tableZone &&
        TABLE_CAPTION_RE.test(prevV.text.trim()) &&
        cap.yTop - (prevV.yTop + Math.max(prevV.fontSize, 6)) < bodySize * 1.5
      cap.tableZone = {
        x0: prevTbl ? Math.min(colX0, prevV.x0) - 2 : colX0,
        x1: colX1,
        y0: (prevTbl ? prevV.yTop : cap.yTop) - 2,
        y1: below.yTop - 2
      }
      cap.tableAlgo = true
      if (prevTbl) lines.splice(i - 1, 1)
      continue
    }
    const all = [cap, ...rows]
    // IEEE 风格：表注 "TABLE N" 紧贴算法标题上方 → 一并纳入裁图区并移除
    const prev = lines[i - 1]
    const prevIsTblCap =
      prev &&
      prev.page === cap.page &&
      !prev.tableZone &&
      TABLE_CAPTION_RE.test(prev.text.trim()) &&
      cap.yTop - (prev.yTop + Math.max(prev.fontSize, 6)) < bodySize * 1.5
    if (prevIsTblCap) all.unshift(prev)
    cap.tableZone = {
      x0: Math.min(...all.map((l) => l.x0)) - 2,
      x1: Math.max(...all.map((l) => l.x1)) + 2,
      y0: Math.min(...all.map((l) => l.yTop)) - 2,
      y1: Math.max(...all.map((l) => l.yTop + Math.max(l.fontSize, 6))) + 2
    }
    cap.tableAlgo = true
    lines.splice(prevIsTblCap ? i - 1 : i + 1, rows.length + (prevIsTblCap ? 1 : 0))
  }
}

/** 公式后的续接句（"where W denotes…"）不打段前空隙，视觉上延续前段 */
const CONT_SENT_RE = /^(where|here|and|but|so|thus|then|such|in which|其中|式中|其中，)\b|[a-z]/i
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
const CAPTION_RE = /^\s*(fig\.?|figure|图)\s*(?:[IVXLC]{1,6}|\d+)\b|^\s*(表|table)\s*(?:[IVXLC]{1,6}|\d+)\b/i
function markCaptions(blocks: ReflowBlock[]): void {
  let hits = 0
  for (const b of blocks) {
    const m = CAPTION_RE.test(b.text)
    if (m && b.kind === 'paragraph' && !b.role && b.text.length < 350) {
      b.role = 'caption'
      hits++
    } else if (m && (b.kind !== 'paragraph' || b.role)) {
    }
  }
}

/* ── 参考文献区（对标 Scholaread pdf_reference_content / no_trans）：
 *    References 标题之后的条目段打 ref-entry 角色——条目串（作者列表 +
 *    期刊卷期页码 + DOI）文本重建本就残缺，送 LLM 翻译只产出垃圾且
 *    烧配额；排版上缩小字号弱化视觉权重。遇附录/致谢标题即止。
 *    实测标题常与首条目合并为一段（"REFERENCES [1] D. Xiaobing…"），
 *    段首匹配 + 含 "[1]" 即认定 ── */

const REFERENCES_HEADING_RE = /^\s*(references?|bibliography|参考文献|文献)\s*$/i
const REFERENCES_START_RE = /^(references?|bibliography|参考文献)\b/i
const REFS_END_HEADING_RE = /^\s*(appendix|appendices|supplementary|acknowledge?ments?|附录|致谢)\b/i

/** 参考文献标题回位：居中排版的 REFERENCES（x0 偏离栏锚）会被列锚评分
 *  排到栏尾，落进文献条目流中间。移回几何位置——同栏、yTop 在其下方的
 *  第一条文本行之前；并打 isRefStart 标记让 linesToBlocks 强制起新块。 */
export function reorderReferenceHeading(lines: Line[]): void {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!REFERENCES_HEADING_RE.test(l.text.trim())) continue
    if (l.text.trim().length > 20) continue
    l.isRefStart = true
    // 几何上的下一条同栏行（文献首条目）
    let target = -1
    for (let j = 0; j < lines.length; j++) {
      const x = lines[j]
      if (j === i || x.page !== l.page) continue
      if (x.yTop <= l.yTop) continue
      if (x.x1 < l.x0 - 40 || x.x0 > l.x1 + 40) continue // 异栏行不算
      if (target === -1 || x.yTop < lines[target].yTop) target = j
    }
    if (target > -1 && target < i) {
      lines.splice(i, 1)
      lines.splice(target, 0, l)
    }
  }
}

export function markReferences(blocks: ReflowBlock[]): void {
  let inRefs = false
  for (const b of blocks) {
    const t = b.text.trim()
    if (!inRefs) {
      // 触发形态①：标题独立成块（heading 或 fs=正文的短行 paragraph）
      if ((b.kind === 'heading' || b.kind === 'paragraph') && REFERENCES_HEADING_RE.test(t)) {
        inRefs = true
        continue
      }
      // 触发形态②：标题与首条目合并为一段（"REFERENCES [1] D. Xiaobing…"
      // 或 tiny-skip 丢掉 [N] 标记后的 "REFERENCES S. Lu, J. Lu…"——
      // 靠条目内的期刊标记（引号/卷期/页码）认定，散文 "References are
      // listed…" 无这些标记天然免疫）
      if (
        b.kind === 'paragraph' &&
        !b.role &&
        REFERENCES_START_RE.test(t) &&
        /["“]|\[\s*\d|vol\.|pp\.|doi:/i.test(t)
      ) {
        inRefs = true
        b.role = 'ref-entry'
      }
      continue
    }
    if (b.kind === 'heading' && REFS_END_HEADING_RE.test(t)) break
    if (b.kind === 'paragraph' && (!b.role || b.role === 'list-item')) b.role = 'ref-entry'
  }
}
