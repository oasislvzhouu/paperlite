import { contextBridge, ipcRenderer } from 'electron'
import type { ImportResult, OpenReadingResult, ReadingMeta } from '../shared/types'

/**
 * 渲染进程唯一的 IPC 出口。
 * 设计原则（吸取逆向 Scholaread 的教训）：
 * - 每个 IPC 通道职责单一、名字带命名空间，不搞万能分发口
 * - 渲染层拿不到文件系统路径之外的任何东西；PDF/缩略图一律走 paperlite:// 协议
 */
const api = {
  listReadings: (): Promise<ReadingMeta[]> => ipcRenderer.invoke('library:list'),
  importPdfs: (): Promise<ImportResult> => ipcRenderer.invoke('library:import'),
  deleteReading: (id: number): Promise<boolean> => ipcRenderer.invoke('library:delete', id),
  openReading: (id: number): Promise<OpenReadingResult | null> =>
    ipcRenderer.invoke('reader:open', id),
  saveProgress: (id: number, page: number, pageCount: number | null): Promise<boolean> =>
    ipcRenderer.invoke('reader:saveProgress', id, page, pageCount),
  saveThumb: (id: number, dataUrl: string): Promise<boolean> =>
    ipcRenderer.invoke('library:saveThumb', id, dataUrl),
  llmStatus: (): Promise<{ baseUrl: string; model: string; hasKey: boolean }> =>
    ipcRenderer.invoke('llm:status'),
  translateParagraphs: (texts: string[]): Promise<string[]> =>
    ipcRenderer.invoke('translate:paragraphs', texts),
  translationsGet: (texts: string[]): Promise<Record<string, string>> =>
    ipcRenderer.invoke('translations:get', texts),
  translationsPut: (items: Array<{ text: string; trans: string }>): Promise<boolean> =>
    ipcRenderer.invoke('translations:put', items),
  translationsPrefetch: (texts: string[]): Promise<{ cached: number; queued: number }> =>
    ipcRenderer.invoke('translations:prefetch', texts),
  recognizeFormula: (dataUrl: string): Promise<string> =>
    ipcRenderer.invoke('formula:recognize', dataUrl),
  pdfUrl: (id: number): string => `paperlite://pdf/${id}`,
  thumbUrl: (id: number): string => `paperlite://thumb/${id}`
}

contextBridge.exposeInMainWorld('paperlite', api)

export type PaperliteApi = typeof api
