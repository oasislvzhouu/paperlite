import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { getDb, libraryDir, thumbPath } from './db'
import { explainImage, llmStatus, parsePageFormulas, recognizeFormula, translateParagraphs } from './llm'
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

  ipcMain.handle('library:delete', async (_e, id: number): Promise<boolean> => {
    const row = getDb().prepare('SELECT * FROM readings WHERE id = ?').get(id) as
      | ReadingMeta
      | undefined
    if (!row) return false
    getDb().prepare('DELETE FROM readings WHERE id = ?').run(id)
    // 只有当没有其他条目共用同一份物理文件（sha 相同）时才处理文件
    const shared = getDb()
      .prepare('SELECT COUNT(*) AS c FROM readings WHERE sha256 = ?')
      .get(row.sha256) as { c: number }
    // 不直接 unlink（误删不可恢复）：移入 userData/trash 保留一份，
    // 用户反悔时可手动找回
    if (shared.c === 0) {
      const trashDir = join(app.getPath('userData'), 'trash')
      const dest = join(trashDir, `${row.sha256.slice(0, 16)}-${id}.pdf`)
      await mkdir(trashDir, { recursive: true }).catch(() => {})
      await rename(row.file_path, dest).catch(() => {
        unlink(row.file_path).catch(() => {})
      })
    }
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
      pageCount: row.page_count,
      sizeBytes: row.size_bytes
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

  /** 进行中的交互翻译个数（切换文献时前后两次可能短暂并存） */
  let interactiveTranslations = 0
  ipcMain.handle('translator:busy', () => interactiveTranslations > 0)
  ipcMain.handle('llm:status', () => llmStatus())

  ipcMain.handle(
    'translate:paragraphs',
    async (
      evt,
      texts: string[],
      lang: string = 'zh-CN',
      doneOffset = 0
    ): Promise<string[]> => {
    if (!Array.isArray(texts) || texts.length === 0) return []
    console.log(`${new Date().toTimeString().slice(0, 8)} [paperlite-main] 翻译请求：${texts.length} 段`)
    interactiveTranslations++
    try {
      return await translateParagraphs(
        texts,
        lang,
        (done, total, aborted) => {
          try {
            evt.sender.send('translation:progress', { done, total, kind: 'interactive', aborted })
          } catch {
            /* 窗口可能已关闭 */
          }
        },
        Number(doneOffset) || 0
      )
    } finally {
      interactiveTranslations--
    }
  })

  ipcMain.handle(
    'pageparse:get',
    (_e, readingId: number, page: number): string | null => {
      const row = getDb()
        .prepare('SELECT blocks_json FROM page_parses WHERE reading_id = ? AND page = ?')
        .get(readingId, page) as { blocks_json: string } | undefined
      return row ? row.blocks_json : null
    }
  )

  ipcMain.handle(
    'pageparse:put',
    (_e, readingId: number, page: number, blocksJson: string): boolean => {
      getDb()
        .prepare(
          'INSERT OR REPLACE INTO page_parses (reading_id, page, blocks_json, created_at) VALUES (?, ?, ?, ?)'
        )
        .run(readingId, page, blocksJson, new Date().toISOString())
      return true
    }
  )

  ipcMain.handle(
    'pageparse:parse',
    async (_e, dataUrl: string): Promise<string> => {
      const list = await parsePageFormulas(dataUrl)
      return JSON.stringify(list)
    }
  )

  ipcMain.handle(
    'vision:explain',
    (_e, dataUrl: string, kind: 'formula' | 'figure'): Promise<string> =>
      explainImage(dataUrl, kind === 'figure' ? 'figure' : 'formula')
  )

  ipcMain.handle('formula:recognize', async (_e, dataUrl: string): Promise<string> => {
    return recognizeFormula(dataUrl)
  })

  /* ── 划线高亮/笔记 ── */

  ipcMain.handle(
    'highlights:list',
    (_e, readingId: number): unknown[] =>
      getDb()
        .prepare('SELECT * FROM highlights WHERE reading_id = ? ORDER BY block_index, start_offset')
        .all(readingId)
  )

  ipcMain.handle(
    'highlights:add',
    (
      _e,
      readingId: number,
      bi: number,
      start: number,
      end: number,
      text: string,
      color: string,
      note: string
    ): number => {
      const res = getDb()
        .prepare(
          `INSERT INTO highlights
           (reading_id, block_index, start_offset, end_offset, text, color, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(readingId, bi, start, end, text, color, note, new Date().toISOString())
      return Number(res.lastInsertRowid)
    }
  )

  ipcMain.handle(
    'highlights:update',
    (_e, id: number, color: string | null, note: string | null): boolean => {
      if (color !== null) {
        getDb().prepare('UPDATE highlights SET color = ? WHERE id = ?').run(color, id)
      }
      if (note !== null) {
        getDb().prepare('UPDATE highlights SET note = ? WHERE id = ?').run(note, id)
      }
      return true
    }
  )

  ipcMain.handle('highlights:remove', (_e, id: number): boolean => {
    getDb().prepare('DELETE FROM highlights WHERE id = ?').run(id)
    return true
  })

  const shaOf = (t: string): string => createHash('sha256').update(t).digest('hex')

  // 译文缓存按「目标语言 + 原文」作键：zh-CN 沿用旧的纯文本键以保留既有缓存
  const tkey = (t: string, lang: string): string => (lang === 'zh-CN' ? t : `[${lang}]${t}`)

  ipcMain.handle('translations:get', (_e, texts: string[], lang = 'zh-CN'): Record<string, string> => {
    const out: Record<string, string> = {}
    const stmt = getDb().prepare('SELECT trans FROM translations WHERE src_sha = ?')
    for (const t of texts) {
      const row = stmt.get(shaOf(tkey(t, lang))) as { trans: string } | undefined
      if (row) out[t] = row.trans
    }
    return out
  })

  ipcMain.handle(
    'translations:put',
    (_e, items: Array<{ text: string; trans: string }>, lang = 'zh-CN'): boolean => {
      const db = getDb()
      const stmt = db.prepare(
        'INSERT OR REPLACE INTO translations (src_sha, trans, created_at) VALUES (?, ?, ?)'
      )
      db.transaction(() => {
        for (const it of items) {
          if (it.text && it.trans)
            stmt.run(shaOf(tkey(it.text, lang)), it.trans, new Date().toISOString())
        }
      })()
      return true
    }
  )

  /** 预翻译任务串行执行：多篇同时跑会并发几十个请求，挤占正在阅读的交互翻译 */
  let prefetchChain: Promise<void> = Promise.resolve()

  /** 导入后预翻译：跳过已缓存的，其余后台跑（不阻塞调用方），每批译完即入库 */
  ipcMain.handle(
    'translations:prefetch',
    async (evt, texts: string[]): Promise<{ cached: number; queued: number }> => {
      const stmt = getDb().prepare('SELECT 1 FROM translations WHERE src_sha = ?')
      const todo: string[] = []
      let cached = 0
      for (const t of texts) {
        if (stmt.get(shaOf(t))) cached++
        else todo.push(t)
      }
      if (todo.length > 0) {
        console.log(`${new Date().toTimeString().slice(0, 8)} [paperlite-main] 预翻译：${todo.length} 段（命中缓存 ${cached}）`)
        const sender = evt.sender
        const run = prefetchChain.then(async () => {
          // 每批译完立即入库：期间用户打开这篇论文时，补翻只请求还没译到的段
          const put = getDb().prepare(
            'INSERT OR REPLACE INTO translations (src_sha, trans, created_at) VALUES (?, ?, ?)'
          )
          let stored = 0
          try {
            await translateParagraphs(
              todo,
              'zh-CN',
              (done, total, aborted) => {
                try {
                  sender.send('translation:progress', { done, total, kind: 'prefetch', aborted })
                } catch {
                  /* 窗口可能已关闭 */
                }
              },
              0,
              {
                // 交互翻译优先：阅读中打开的那篇先译完，预翻译再继续
                beforeBatch: async () => {
                  while (interactiveTranslations > 0) await new Promise((r) => setTimeout(r, 1000))
                },
                // 排队期间可能已被交互翻译补上：整批都有缓存就不再请求
                skip: (batch) => batch.every((t) => stmt.get(shaOf(t))),
                onBatch: (start, part) => {
                  stored += getDb().transaction(() => {
                    let n = 0
                    part.forEach((trans, k) => {
                      if (!trans) return
                      put.run(shaOf(todo[start + k]), trans, new Date().toISOString())
                      n++
                    })
                    return n
                  })()
                }
              }
            )
            console.log(`${new Date().toTimeString().slice(0, 8)} [paperlite-main] 预翻译完成并入库：${stored} 段`)
          } catch (err) {
            console.log(`[paperlite-main] 预翻译失败（已入库 ${stored} 段）:`, err)
          }
        })
        // 某一篇失败不阻塞后面排队的任务
        prefetchChain = run.catch(() => {})
      }
      return { cached, queued: todo.length }
    }
  )
}
