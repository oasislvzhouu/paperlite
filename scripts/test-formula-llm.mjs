import * as mupdf from 'mupdf'
import { readFileSync, writeFileSync } from 'node:fs'

const f = 'C:/Users/admin/Desktop/论文下载/downloads/2026-10-28/ieee/Trainable Pseudo-Label Generator With Reinforcement Learning for Indus.pdf'
const doc = mupdf.Document.openDocument(readFileSync(f), 'application/pdf')
const page = doc.loadPage(3) // 第 4 页（公式密集页）
const pixmap = page.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB)
const png = pixmap.asPNG()
writeFileSync('scripts/tmp-page4.png', png)
console.log('页面图已保存:', png.length, 'bytes')

const b64 = Buffer.from(png).toString('base64')
const body = {
  model: 'glm-5.3-flash',
  max_tokens: 8192,
  thinking: { type: 'disabled' },
  messages: [
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
        {
          type: 'text',
          text:
            '这是论文页面图片。找出页面中所有独立成行的 display 数学公式（通常带编号 (1) (2)...，' +
            '不含正文行内符号），按出现顺序把每个公式转写为 LaTeX。' +
            '只输出 JSON 数组：["公式1的LaTeX", "公式2的LaTeX", ...]，' +
            '每个元素是一条完整公式（多行公式合并为一条），不含编号 (N)，不要解释。' +
            '若页面没有 display 公式，输出 []。忽略公式周边的英文正文文字。'
        }
      ]
    }
  ]
}
const res = await fetch('https://open.bigmodel.cn/api/anthropic/v1/messages', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': '88c69bff389a49dfb173a0ba4a238ed5.ZtD94el40zrcvzqp',
    'anthropic-version': '2023-06-01'
  },
  body: JSON.stringify(body)
})
const data = await res.json()
const raw = (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
console.log('=== LLM 原始响应（前 600 字符）===')
console.log(raw.slice(0, 600))
console.log('=== stop_reason:', data.stop_reason, 'usage:', JSON.stringify(data.usage ?? {}))
