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

/** 带 HTTP 状态码的 LLM 错误：429/5xx 是瞬时故障，可退避重试；
 *  其余（401/400/超时/断网）重试没有意义 */
class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
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
  let data: AnthropicResponse
  try {
    data = (await res.json()) as AnthropicResponse
  } catch (err) {
    // 网关返回的非 JSON 错误页（502/503）：按状态码报错，调用方可据此重试
    if (res.ok) throw err
    data = {}
  }
  if (!res.ok || data.error) {
    throw new LlmHttpError(res.status, `LLM ${res.status}: ${data.error?.message ?? res.statusText}`)
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
      max_tokens: 16000,
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

/** 整页公式批量提取：页面图 → 按出现顺序的 LaTeX 数组 */
export async function parsePageFormulas(dataUrl: string): Promise<string[]> {
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
    }),
    signal: AbortSignal.timeout(180_000)
  })
  const data = (await res.json()) as AnthropicResponse
  if (!res.ok || data.error) throw new Error(`LLM ${res.status}: ${data.error?.message ?? res.statusText}`)
  const raw = (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
  const jsonText = raw.replace(/```(?:json)?/g, '')
  const start = jsonText.indexOf('[')
  const end = jsonText.lastIndexOf(']')
  if (start === -1 || end === -1) return []
  try {
    const arr = JSON.parse(jsonText.slice(start, end + 1))
    if (!Array.isArray(arr)) return []
    return arr.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
  } catch {
    return []
  }
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
/** 译文目标语言（对标 Scholaread 的 ReaderTargetLanguageSelect） */
export const LANG_NAMES: Record<string, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어'
}

/** 限流/服务端错误后的重试等待（第 1、2 次重试前） */
const RETRY_WAITS = [3000, 8000]
const clock = (): string => new Date().toTimeString().slice(0, 8)

export async function translateParagraphs(
  texts: string[],
  lang: string = 'zh-CN',
  /** aborted=true：因接口持续报错提前结束（后面的批次没有请求） */
  onProgress?: (done: number, total: number, aborted?: boolean) => void,
  /** 已有译文的段数：进度按全篇段落计数（done/total 都加上它） */
  doneOffset = 0,
  hooks?: {
    /** 取下一批前执行（后台预翻译在此让路给交互翻译） */
    beforeBatch?: () => Promise<void>
    /** 返回 true 表示该批次已被别的请求译好，跳过 */
    skip?: (batch: string[]) => boolean
    /** 每批译完立即回调（start 为该批在 texts 中的起点）：预翻译据此逐批入库 */
    onBatch?: (start: number, results: string[]) => void
  }
): Promise<string[]> {
  const langName = LANG_NAMES[lang] ?? LANG_NAMES['zh-CN']
  const out: string[] = new Array(texts.length).fill('')
  const BATCH = 6
  const jobs: Array<{ start: number; batch: string[] }> = []
  for (let i = 0; i < texts.length; i += BATCH) {
    jobs.push({ start: i, batch: texts.slice(i, i + BATCH) })
  }
  const CONCURRENCY = 4
  let cursor = 0
  let completed = 0
  let ok = 0
  let failed = 0
  const report = (): void => {
    if (onProgress) onProgress(doneOffset + completed, doneOffset + texts.length)
  }
  async function worker(): Promise<void> {
    while (cursor < jobs.length) {
      // 连续两个批次失败且无一成功（密钥失效/断网/限流）：剩下的批次不会
      // 更好，继续等只会让每个请求各挂到 120 秒超时、进度停住好几分钟
      if (failed >= 2 && ok === 0) return
      if (hooks?.beforeBatch) await hooks.beforeBatch()
      // 让路期间其它 worker 可能已把批次取完，await 之后要重新判断
      if (cursor >= jobs.length) return
      const job = jobs[cursor++]
      if (hooks?.skip?.(job.batch)) {
        completed += job.batch.length
        report()
        continue
      }
      // 全局编号标记协议：每段带 [[N]]，LLM 输出按 [[N]] 配对回写。
      // 旧的等长 JSON 数组协议在 LLM 合并/拆分段落时产生错位污染
      const tagged = texts
        .slice(job.start, job.start + job.batch.length)
        .map((t, i) => `[[${job.start + i}]]${t}`)
        .join('\n\n')
      const prompt =
        '你是专业的学术文献翻译。下面有多个带 [[N]] 序号标记的段落，' +
        `把每段翻译成准确、流畅的${langName}。输出格式：每条译文以原序号标记 [[N]] 开头` +
        '（N 与输入一致，顺序不限），仅输出译文本身，不要解释。' +
        '保留数学符号与变量（如 x、α、Q-learning 不译）、保留引用标记（如 [8]、Fig. 2）。\n\n' +
        tagged
      for (let attempt = 1; ; attempt++) {
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
          if (out.slice(job.start, job.start + job.batch.length).some(Boolean)) ok++
          break
        } catch (err) {
          // 限流（429）/服务端错误是瞬时的：退避后重试。实测 4 并发会触发
          // 账户速率限制（1302），一批直接放弃就是 6 段没有译文
          const status = err instanceof LlmHttpError ? err.status : 0
          if ((status === 429 || status >= 500) && attempt <= RETRY_WAITS.length) {
            const wait = RETRY_WAITS[attempt - 1] + Math.random() * 1500
            console.log(
              `${clock()} [paperlite-main] 翻译批次 @${job.start} 暂不可用（${status}），${Math.round(wait / 1000)} 秒后重试`
            )
            await new Promise((r) => setTimeout(r, wait))
            continue
          }
          failed++
          console.log(`${clock()} [paperlite-main] 翻译批次 @${job.start} 失败:`, err)
          break
        }
      }
      completed += job.batch.length
      report()
      if (hooks?.onBatch) hooks.onBatch(job.start, out.slice(job.start, job.start + job.batch.length))
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker))
  // 熔断提前结束：补一次终态上报，否则界面上的进度浮标会一直停在半截转圈
  if (failed >= 2 && ok === 0 && onProgress) onProgress(doneOffset + completed, doneOffset + texts.length, true)
  return out
}

/** 解释一段公式或图表（视觉模型，输出中文说明） */
export async function explainImage(dataUrl: string, kind: 'formula' | 'figure'): Promise<string> {
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(dataUrl)
  if (!m) throw new Error('图片格式不支持（需 PNG/JPEG dataURL）')
  const { llm } = loadSettings()
  if (!llm.apiKey) throw new Error('未配置 API Key')
  const mediaType = m[1] === 'png' ? 'image/png' : 'image/jpeg'
  const ask =
    kind === 'formula'
      ? '这是一篇学术论文中的公式。请用简体中文回答：1) 它表达的是什么关系/含义；2) 各个符号分别代表什么；3) 它在论文中的作用。直接给结论，200 字以内，不要客套话。'
      : '这是一篇学术论文中的图表。请用简体中文回答：1) 它展示了什么；2) 横纵轴或各元素代表什么；3) 作者想说明的主要结论。直接给结论，200 字以内，不要客套话。'
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
            { type: 'text', text: ask }
          ]
        }
      ]
    }),
    signal: AbortSignal.timeout(90_000)
  })
  const data = (await res.json()) as AnthropicResponse
  if (!res.ok || data.error) throw new Error(`LLM ${res.status}: ${data.error?.message ?? res.statusText}`)
  return (data.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('')
    .trim()
}
