import { BrowserWindow, dialog, ipcMain } from 'electron'
import { createHash } from 'node:crypto'
import { copyFile, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { getDb, libraryDir, thumbPath } from './db'
import { llmStatus, recognizeFormula, translateParagraphs } from './llm'
import type { ImportResult, OpenReadingResult, ReadingMeta } from '../shared/types'

const isPdf = (name: string): boolean => /\.pdf$/i.test(name)

export function registerIpc(): void {
  ipcMain.handle('library:list', (): ReadingMeta[] => {
    const rows = getDb()
      .prepare(
        `SELECT * FROM readings
         ORDER BY (last_opened_at IS NULL), last_opened_at DESC, added_at DESC`
      )
      .all() as ReadingMeta[]
    console.log(`[paperlite-main] library:list → ${rows.length} 条`)
    return rows
  })

  ipcMain.handle('library:import', async (evt): Promise<ImportResult> => {
    const win = BrowserWindow.fromWebContents(evt.sender)
    if (!win) return { imported: [], duplicates: [], invalid: [] }
    const picked = await dialog.showOpenDialog(win, {
      title: '导入 PDF 文献',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile', 'multiSelections']
    })
    if (picked.canceled || picked.filePaths.length === 0) {
      return { imported: [], duplicates: [], invalid: [] }
    }

    const imported: ReadingMeta[] = []
    const duplicates: string[] = []
    const invalid: string[] = []
    for (const src of picked.filePaths) {
      if (!isPdf(src)) {
        invalid.push(basename(src))
        continue
      }
      const buf = await readFile(src)
      const sha = createHash('sha256').update(buf).digest('hex')
      const dup = getDb().prepare('SELECT id FROM readings WHERE sha256 = ?').get(sha)
      if (dup) {
        duplicates.push(basename(src))
        continue
      }
      const dest = join(libraryDir(), `${sha}.pdf`)
      await copyFile(src, dest)
      const info = await stat(dest)
      const title = basename(src).replace(/\.pdf$/i, '')
      const now = new Date().toISOString()
      const res = getDb()
        .prepare(
          `INSERT INTO readings (title, file_path, original_name, size_bytes, sha256, added_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(title, dest, basename(src), info.size, sha, now)
      imported.push({
        id: Number(res.lastInsertRowid),
        title,
        file_path: dest,
        original_name: basename(src),
        page_count: null,
        size_bytes: info.size,
        sha256: sha,
        added_at: now,
        last_opened_at: null,
        last_page: 1
      })
    }
    return { imported, duplicates, invalid }
  })

  ipcMain.handle('library:delete', (_e, id: number): boolean => {
    const row = getDb().prepare('SELECT * FROM readings WHERE id = ?').get(id) as
      | ReadingMeta
      | undefined
    if (!row) return false
    getDb().prepare('DELETE FROM readings WHERE id = ?').run(id)
    // 只有当没有其他条目共用同一份物理文件（sha 相同）时才删除文件
    const shared = getDb()
      .prepare('SELECT COUNT(*) AS c FROM readings WHERE sha256 = ?')
      .get(row.sha256) as { c: number }
    if (shared.c === 0) unlink(row.file_path).catch(() => {})
    unlink(thumbPath(id)).catch(() => {})
    return true
  })

  ipcMain.handle('reader:open', (_e, id: number): OpenReadingResult | null => {
    const row = getDb().prepare('SELECT * FROM readings WHERE id = ?').get(id) as
      | ReadingMeta
      | undefined
    if (!row) return null
    getDb().prepare('UPDATE readings SET last_opened_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      id
    )
    return {
      id: row.id,
      title: row.title,
      url: `paperlite://pdf/${row.id}`,
      lastPage: row.last_page,
      pageCount: row.page_count
    }
  })

  ipcMain.handle(
    'reader:saveProgress',
    (_e, id: number, page: number, pageCount: number | null): boolean => {
      getDb()
        .prepare('UPDATE readings SET last_page = ?, page_count = COALESCE(?, page_count) WHERE id = ?')
        .run(page, pageCount, id)
      return true
    }
  )

  ipcMain.handle('library:saveThumb', async (_e, id: number, dataUrl: string): Promise<boolean> => {
    const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl)
    if (!m) return false
    await writeFile(thumbPath(id), Buffer.from(m[1], 'base64'))
    console.log(`[paperlite-main] saveThumb id=${id} ok`)
    return true
  })

  ipcMain.handle('llm:status', () => llmStatus())

  ipcMain.handle('translate:paragraphs', async (_e, texts: string[]): Promise<string[]> => {
    if (!Array.isArray(texts) || texts.length === 0) return []
    console.log(`[paperlite-main] 翻译请求：${texts.length} 段`)
    return translateParagraphs(texts)
  })

  ipcMain.handle('formula:recognize', async (_e, dataUrl: string): Promise<string> => {
    return recognizeFormula(dataUrl)
  })

  /* ── 翻译持久缓存（按源文 SHA-256 全局去重） ── */

  const shaOf = (t: string): string => createHash('sha256').update(t).digest('hex')

  ipcMain.handle('translations:get', (_e, texts: string[]): Record<string, string> => {
    const out: Record<string, string> = {}
    const stmt = getDb().prepare('SELECT trans FROM translations WHERE src_sha = ?')
    for (const t of texts) {
      const row = stmt.get(shaOf(t)) as { trans: string } | undefined
      if (row) out[t] = row.trans
    }
    return out
  })

  ipcMain.handle(
    'translations:put',
    (_e, items: Array<{ text: string; trans: string }>): boolean => {
      const db = getDb()
      const stmt = db.prepare(
        'INSERT OR REPLACE INTO translations (src_sha, trans, created_at) VALUES (?, ?, ?)'
      )
      db.transaction(() => {
        for (const it of items) {
          if (it.text && it.trans) stmt.run(shaOf(it.text), it.trans, new Date().toISOString())
        }
      })()
      return true
    }
  )

  /** 导入后预翻译：跳过已缓存的，其余后台跑（不阻塞调用方），完成即入库 */
  ipcMain.handle(
    'translations:prefetch',
    async (_e, texts: string[]): Promise<{ cached: number; queued: number }> => {
      const stmt = getDb().prepare('SELECT 1 FROM translations WHERE src_sha = ?')
      const todo: string[] = []
      let cached = 0
      for (const t of texts) {
        if (t.length < 30) continue
        if (stmt.get(shaOf(t))) cached++
        else todo.push(t)
      }
      if (todo.length > 0) {
        console.log(`[paperlite-main] 预翻译：${todo.length} 段（命中缓存 ${cached}）`)
        void (async () => {
          try {
            const results = await translateParagraphs(todo)
            const items = todo
              .map((text, i) => ({ text, trans: results[i] ?? '' }))
              .filter((x) => x.trans)
            if (items.length > 0) {
              const put = getDb().prepare(
                'INSERT OR REPLACE INTO translations (src_sha, trans, created_at) VALUES (?, ?, ?)'
              )
              getDb().transaction(() => {
                for (const it of items) {
                  put.run(shaOf(it.text), it.trans, new Date().toISOString())
                }
              })()
              console.log(`[paperlite-main] 预翻译完成并入库：${items.length} 段`)
            }
          } catch (err) {
            console.log('[paperlite-main] 预翻译失败：', err)
          }
        })()
      }
      return { cached, queued: todo.length }
    }
  )
}
