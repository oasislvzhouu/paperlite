p = r'C:\Users\admin\Desktop\逆向工程\paperlite\src\main\llm.ts'
s = open(p, encoding='utf-8').read()

anchor = "/** 公式图片 → LaTeX（视觉识别） */"
assert anchor in s

new_fn = '''/** 整页视觉解析：页面图 → 结构化内容（标题/段落/公式 LaTeX/图注） */
export interface ParsedBlock {
  type: 'heading' | 'paragraph' | 'formula' | 'caption'
  text?: string
  latex?: string
}

const PAGE_PROMPT_HEADER =
  '你是学术论文版面解析引擎。这是一页 IEEE 双栏论文的图片。将它按阅读顺序（先左栏后右栏，跨栏元素按位置）转换为 JSON：\\n' +
  '{"blocks": [\\n' +
  ' {"type": "heading", "text": "章节标题原文"},\\n' +
  ' {"type": "paragraph", "text": "正文段落逐字原文"},\\n' +
  ' {"type": "formula", "latex": "display 公式的 LaTeX"},\\n' +
  ' {"type": "caption", "text": "图/表标题原文"}\\n' +
  ']}\\n' +
  '要求：\\n' +
  '1. paragraph 必须逐字转录原文（OCR 任务），不得总结、改写、遗漏或合并段落\\n' +
  '2. 独立成行的 display 公式转 LaTeX（用 \\frac 等完整结构，不含编号 (N)）；行内数学符号保留在段落文本中\\n' +
  '3. 图表标题（Fig. x. / TABLE x.）用 caption 类型\\n' +
  '4. 页眉、页脚、期刊名、页码、版权声明忽略不输出\\n' +
  '5. 图表本身的图形内容不输出文字\\n' +
  '只输出 JSON，不要 markdown 代码块或解释。\\n\\n'

export async function parsePageStructured(dataUrl: string): Promise<ParsedBlock[]> {
  const mm = /^data:image\\/(png|jpeg);base64,(.+)$/.exec(dataUrl)
  if (!mm) throw new Error('页面图片格式不支持')
  const { llm } = loadSettings()
  if (!llm.apiKey) throw new Error('未配置 API Key')
  const mediaType = mm[1] === 'png' ? 'image/png' : 'image/jpeg'
  const res = await fetch(`${llm.baseUrl.replace(/\\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': llm.apiKey,
      authorization: `Bearer ${llm.apiKey}`,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: llm.model,
      max_tokens: 8192,
      thinking: { type: 'disabled' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: mm[2] } },
            { type: 'text', text: PAGE_PROMPT_HEADER }
          ]
        }
      ]
    }),
    signal: AbortSignal.timeout(180_000)
  })
  const data = (await res.json()) as AnthropicResponse
  if (!res.ok || data.error) throw new Error(`LLM ${res.status}: ${data.error?.message ?? res.statusText}`)
  const raw = (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
  const jsonText = raw.replace(/```(?:json)?/g, '')
  const start = jsonText.indexOf('{')
  const end = jsonText.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('响应中找不到 JSON')
  const parsed = JSON.parse(jsonText.slice(start, end + 1)) as { blocks?: ParsedBlock[] }
  if (!Array.isArray(parsed.blocks)) throw new Error('响应缺少 blocks 数组')
  return parsed.blocks.filter(
    (b) => b && typeof b.type === 'string' && (typeof b.text === 'string' || typeof b.latex === 'string')
  )
}

'''
s = s.replace(anchor, new_fn + anchor)
open(p, 'w', encoding='utf-8').write(s)
print('parsePageStructured in')
