p = r'C:\Users\admin\Desktop\逆向工程\paperlite\src\main\llm.ts'
s = open(p, encoding='utf-8').read()

old = """  async function worker(): Promise<void> {
    while (cursor < jobs.length) {
      const job = jobs[cursor++]
      const payload = JSON.stringify(job.batch)
      const prompt =
        '你是专业的学术文献翻译。把下面 JSON 数组中的每个英文段落翻译成准确、流畅的简体中文，' +
        '保留数学符号与变量（如 x、α、Q-learning 不译）、保留引用标记（如 [8]、Fig. 2）。' +
        '只返回等长的 JSON 字符串数组，不要任何解释。\\n\\n' +
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
  }"""

new = """  async function worker(): Promise<void> {
    while (cursor < jobs.length) {
      const job = jobs[cursor++]
      // 全局编号标记协议：每段带 [[N]]，LLM 输出按 [[N]] 配对回写。
      // 旧的等长 JSON 数组协议在 LLM 合并/拆分段落时产生错位污染
      const tagged = texts
        .slice(job.start, job.start + job.batch.length)
        .map((t, i) => `[[${job.start + i}]]${t}`)
        .join('\\n\\n')
      const prompt =
        '你是专业的学术文献翻译。下面有多个带 [[N]] 序号标记的英文段落，' +
        '把每段翻译成准确、流畅的简体中文。输出格式：每条译文以原序号标记 [[N]] 开头' +
        '（N 与输入一致，顺序不限），仅输出译文本身，不要解释。' +
        '保留数学符号与变量（如 x、α、Q-learning 不译）、保留引用标记（如 [8]、Fig. 2）。\\n\\n' +
        tagged
      try {
        const reply = await chat(prompt)
        const re = /\\[\\[(\\d{1,4})\\]\\]([\\s\\S]*?)(?=\\[\\[\\d{1,4}\\]\\]|$)/g
        let mm: RegExpExecArray | null
        while ((mm = re.exec(reply))) {
          const idx = Number(mm[1])
          const val = mm[2].replace(/\\s+/g, ' ').trim()
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
  }"""
assert old in s, 'worker not found'
s = s.replace(old, new)
open(p, 'w', encoding='utf-8').write(s)
print('numbered protocol in')
