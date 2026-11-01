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
      const payload = JSON.stringify(job.batch)
      const prompt =
        '你是专业的学术文献翻译。把下面 JSON 数组中的每个英文段落翻译成准确、流畅的简体中文，' +
        '保留数学符号与变量（如 x、α、Q-learning 不译）、保留引用标记（如 [8]、Fig. 2）。' +
        '只返回等长的 JSON 字符串数组，不要任何解释。\n\n' +
        payload
      try {
        const reply = await chat(prompt)
        const arr = extractJsonArray(reply)
        if (Array.isArray(arr)) {
          arr.forEach((t, k) => {
            if (typeof t === 'string' && job.start + k < out.length) out[job.start + k] = t
          })
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
