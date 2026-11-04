p = r'C:\Users\admin\Desktop\逆向工程\paperlite\src\renderer\src\reflow.ts'
s = open(p, encoding='utf-8').read()

anchor = "export async function extractReflowBlocks(doc: PDFDocumentProxy): Promise<ReflowBlock[]> {"
assert anchor in s

mupdf_fn = r'''export interface MupdfPageLike {
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
    const lines: Line[] = []
    for (const block of stext.blocks) {
      for (const l of block.lines ?? []) {
        const text = (l.text ?? '').replace(/\s+/g, ' ').trim()
        if (!text) continue
        const bb = l.bbox
        const words = text.split(/\s+/).filter(Boolean)
        const shortWords = words.filter((w) => w.replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, '').length <= 1).length
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
          html: text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
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
  detectTableZones(ordered, bodySize)
  const blocks = linesToBlocks(ordered, bodySize)
  structureFirstPage(blocks)
  demoteFootnotes(blocks, bodySize)
  mergeFormulaDebris(blocks, bodySize)
  markFormulaContinuation(blocks)
  markCaptions(blocks)
  return blocks
}

'''
s = s.replace(anchor, mupdf_fn + anchor)
open(p, 'w', encoding='utf-8').write(s)
print('mupdf layer in')
