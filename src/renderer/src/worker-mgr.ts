/** pdf.js worker 生命周期管理（内联 worker + toHex polyfill） */
import * as pdfjsLib from 'pdfjs-dist'
import PdfjsWorker from './pdf-worker?worker&inline'

let worker: Worker | null = null
let generation = 0

function spawn(): Worker {
  const w = new PdfjsWorker()
  w.onerror = (e) => {
    const g = globalThis as { __plWorkerErr?: string[] }
    g.__plWorkerErr = [...(g.__plWorkerErr ?? []), String(e.message ?? e)]
    console.error('[paperlite] pdf worker 异常:', e.message ?? e)
  }
  return w
}

worker = spawn()
pdfjsLib.GlobalWorkerOptions.workerPort = worker

/** 销毁当前 worker 并重建（仅可在没有进行中任务时调用） */
export function recreatePdfWorker(): number {
  try {
    worker?.terminate()
  } catch {
    /* ignore */
  }
  worker = spawn()
  pdfjsLib.GlobalWorkerOptions.workerPort = worker
  generation += 1
  const g = globalThis as { __plWorkerGen?: number }
  g.__plWorkerGen = generation
  return generation
}
