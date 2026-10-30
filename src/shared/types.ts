/** 主进程与渲染进程共享的类型定义 */

export interface ReadingMeta {
  id: number
  title: string
  file_path: string
  original_name: string
  page_count: number | null
  size_bytes: number
  sha256: string
  added_at: string
  last_opened_at: string | null
  last_page: number
}

export interface ImportResult {
  imported: ReadingMeta[]
  /** 已在书架中（SHA-256 相同）被跳过的文件名 */
  duplicates: string[]
  /** 非 PDF 文件名 */
  invalid: string[]
}

export interface OpenReadingResult {
  id: number
  title: string
  url: string
  lastPage: number
  pageCount: number | null
}
