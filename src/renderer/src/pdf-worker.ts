/**
 * pdf.js 自定义 worker 入口。
 *
 * pdf.js ≥5.7 计算 PDF 指纹时调用 Uint8Array.prototype.toHex()（Chromium 140+ 才有），
 * Electron 37 的 Chromium 138 缺这个 API，必须先打补丁再加载 worker。
 * 注意：静态 import 会被提升，但 toHex 只在文档解析（运行时）调用，晚于本文件的补丁语句，安全。
 */
if (typeof (Uint8Array.prototype as unknown as { toHex?: unknown }).toHex !== 'function') {
  ;(Uint8Array.prototype as unknown as { toHex: () => string }).toHex = function (
    this: Uint8Array
  ): string {
    let out = ''
    for (let i = 0; i < this.length; i++) out += this[i].toString(16).padStart(2, '0')
    return out
  }
}
import 'pdfjs-dist/build/pdf.worker.min.mjs'
