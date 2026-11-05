import { loadSettings } from './settings'

/** 渲染层可见的状态（永远不含密钥本体） */
export interface LlmStatus {
  baseUrl: string
  model: string
  hasKey: boolean
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>
  error?: { message?: string }
}

export function llmStatus(): LlmStatus {
  const { llm } = loadSettings()
  return { baseUrl: llm.baseUrl, model: llm.model, hasKey: llm.apiKey.length > 0 }
}

async function chat(prompt: string, maxTokens = 8192): Promise<string> {
  const { llm } = loadSettings()
  if (!llm.apiKey) throw new Error('未配置 API Key（settings.json → llm.apiKey）')
  const res = await fetch(`${llm.baseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': llm.apiKey,
      authorization: `Bearer ${llm.apiKey}`,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: llm.model,
      max_tokens: maxTokens,
      // 翻译任务不需要推理，关掉 thinking 大幅降低延迟
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: prompt }]
    }),
    signal: AbortSignal.timeout(120_000)
  })
  const data = (await res.json()) as AnthropicResponse
  if (!res.ok || data.error) {
    throw new Error(`LLM ${res.status}: ${data.error?.message ?? res.statusText}`)
  }
  return (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
}

function extractJsonArray(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fence ? fence[1] : text
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) throw new Error('响应中找不到 JSON 数组')
  return JSON.parse(body.slice(start, end + 1))
}

/** LaTeX 污染检测：LLM 偶发把公式周边的英文正文转写进 latex。
 *  判据：剔除 LaTeX 命令后，剩余 ≥4 字母的英文单词 ≥3 个 → 混入正文 */
export function isPollutedLatex(latex: string): boolean {
  const noCmds = latex.replace(/\[A-Za-z]+/g, ' ').replace(/[{}$^_&]/g, ' ')
  const longWords = noCmds.match(/[A-Za-z]{4,}/g) ?? []
  return longWords.length >= 3
}

/** 整页视觉解析：页面图 → 结构化内容（标题/段落/公式 LaTeX/图注） */
export interface ParsedBlock {
  type: 'heading' | 'paragraph' | 'formula' | 'caption'
  text?: string
  latex?: string
}

const PAGE_PROMPT_HEADER =
  '你是学术论文版面解析引擎。这是一页 IEEE 双栏论文的图片。将它按阅读顺序（先左栏后右栏，跨栏元素按位置）转换为 JSON：\n' +
  '{"blocks": [\n' +
  ' {"type": "heading", "text": "章节标题原文"},\n' +
  ' {"type": "paragraph", "text": "正文段落逐字原文"},\n' +
  ' {"type": "formula", "latex": "display 公式的 LaTeX"},\n' +
  ' {"type": "caption", "text": "图/表标题原文"}\n' +
  ']}\n' +
  '要求：\n' +
  '1. paragraph 必须逐字转录原文（OCR 任务），不得总结、改写、遗漏或合并段落\n' +
  '2. 独立成行的 display 公式转 LaTeX（用 \frac 等完整结构，不含编号 (N)）；行内数学符号保留在段落文本中\n' +
  '   公式 latex 只包含数学表达式本身——公式上/下方紧邻的英文正文句子属于 paragraph，不要放进 latex\n' +
  '3. 图表标题（Fig. x. / TABLE x.）用 caption 类型\n' +
  '4. 页眉、页脚、期刊名、页码、版权声明忽略不输出\n' +
  '5. 图表本身的图形内容不输出文字\n' +
  '只输出 JSON，不要 markdown 代码块或解释。\n\n'

export async function parsePageStructured(dataUrl: string): Promise<ParsedBlock[]> {
  const mm = /^data:image\/(png|jpeg);base64,(.+)$/.exec(dataUrl)
  if (!mm) throw new Error('页面图片格式不支持')
  const { llm } = loadSettings()
  if (!llm.apiKey) throw new Error('未配置 API Key')
  const mediaType = mm[1] === 'png' ? 'image/png' : 'image/jpeg'
  const res = await fetch(`${llm.baseUrl.replace(/\/$/, '')}/v1/messages`, {
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

/** 公式图片 → LaTeX（视觉识别） */
export async function recognizeFormula(dataUrl: string): Promise<string> {
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(dataUrl)
  if (!m) throw new Error('公式图片格式不支持（需 PNG/JPEG dataURL）')
  const { llm } = loadSettings()
  if (!llm.apiKey) throw new Error('未配置 API Key')
  const mediaType = m[1] === 'png' ? 'image/png' : 'image/jpeg'
  const res = await fetch(`${llm.baseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': llm.apiKey,
      authorization: `Bearer ${llm.apiKey}`,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: llm.model,
      max_tokens: 1024,
      thinking: { type: 'disabled' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: m[2] } },
            {
              type: 'text',
              text: '把图中的数学公式精确转写为一段 LaTeX 代码（不含公式编号）。只输出 LaTeX 代码本身，不要 $、\\[、\\] 定界符，不要解释。'
            }
          ]
        }
      ]
    }),
    signal: AbortSignal.timeout(90_000)
  })
  const data = (await res.json()) as AnthropicResponse
  if (!res.ok || data.error) throw new Error(`LLM ${res.status}: ${data.error?.message ?? res.statusText}`)
  const raw = (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
  return raw
    .replace(/```(?:latex|tex)?/g, '')
    .replace(/^\$+|\$+$/g, '')
    .replace(/^\\\[|\\\]$/g, '')
    // LLM 偶发把公式编号 / 无法识别字符（¿）带进输出
    .replace(/\(\d{1,2}\)\s*$/, '')
    .replace(/¿/g, '')
    .trim()
}
export async function translateParagraphs(
  texts: string[],
  onProgress?: (done: number, total: number) => void
): Promise<string[]> {
  const out: string[] = new Array(texts.length).fill('')
  const BATCH = 6
  const jobs: Array<{ start: number; batch: string[] }> = []
  for (let i = 0; i < texts.length; i += BATCH) {
    jobs.push({ start: i, batch: texts.slice(i, i + BATCH) })
  }
  const CONCURRENCY = 4
  let cursor = 0
  let completed = 0
  const report = (): void => {
    if (onProgress) onProgress(completed, texts.length)
  }
  async function worker(): Promise<void> {
    while (cursor < jobs.length) {
      const job = jobs[cursor++]
      // 全局编号标记协议：每段带 [[N]]，LLM 输出按 [[N]] 配对回写。
      // 旧的等长 JSON 数组协议在 LLM 合并/拆分段落时产生错位污染
      const tagged = texts
        .slice(job.start, job.start + job.batch.length)
        .map((t, i) => `[[${job.start + i}]]${t}`)
        .join('\n\n')
      const prompt =
        '你是专业的学术文献翻译。下面有多个带 [[N]] 序号标记的英文段落，' +
        '把每段翻译成准确、流畅的简体中文。输出格式：每条译文以原序号标记 [[N]] 开头' +
        '（N 与输入一致，顺序不限），仅输出译文本身，不要解释。' +
        '保留数学符号与变量（如 x、α、Q-learning 不译）、保留引用标记（如 [8]、Fig. 2）。\n\n' +
        tagged
      try {
        const reply = await chat(prompt)
        const re = /\[\[(\d{1,4})\]\]([\s\S]*?)(?=\[\[\d{1,4}\]\]|$)/g
        let mm: RegExpExecArray | null
        while ((mm = re.exec(reply))) {
          const idx = Number(mm[1])
          const val = mm[2].replace(/\s+/g, ' ').trim()
          if (idx >= job.start && idx < job.start + job.batch.length && val && !out[idx]) {
            out[idx] = val
          }
        }
      } catch (err) {
        console.log(`[paperlite-main] 翻译批次 @${job.start} 失败:`, err)
      } finally {
        completed += job.batch.length
        report()
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker))
  return out
}
