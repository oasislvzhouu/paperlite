/** LLM 公式识别共享判定（主进程与渲染层各自实现的逻辑镜像） */
export function isPollutedLatex(latex: string): boolean {
  const noCmds = latex.replace(/\\[A-Za-z]+/g, ' ').replace(/[{}$^_&]/g, ' ')
  const longWords = noCmds.match(/[A-Za-z]{4,}/g) ?? []
  return longWords.length >= 3
}
