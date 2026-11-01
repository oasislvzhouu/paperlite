import Database from 'better-sqlite3'
import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ReadingMeta } from '../shared/types'

let db: Database.Database | null = null

export const libraryDir = (): string => join(app.getPath('userData'), 'library')
export const thumbsDir = (): string => join(app.getPath('userData'), 'thumbs')
export const thumbPath = (id: number): string => join(thumbsDir(), `${id}.png`)

export function getDb(): Database.Database {
  if (!db) throw new Error('database not initialised')
  return db
}

export function initDb(): void {
  mkdirSync(libraryDir(), { recursive: true })
  mkdirSync(thumbsDir(), { recursive: true })
  db = new Database(join(app.getPath('userData'), 'paperlite.db'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS readings (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      title            TEXT NOT NULL,
      file_path        TEXT NOT NULL UNIQUE,
      original_name    TEXT NOT NULL,
      page_count       INTEGER,
      size_bytes       INTEGER NOT NULL,
      sha256           TEXT NOT NULL UNIQUE,
      added_at         TEXT NOT NULL,
      last_opened_at   TEXT,
      last_page        INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_readings_recent
      ON readings(last_opened_at DESC, added_at DESC);
    CREATE TABLE IF NOT EXISTS translations (
      src_sha    TEXT PRIMARY KEY,
      trans      TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS highlights (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      reading_id   INTEGER NOT NULL,
      block_index  INTEGER NOT NULL,
      start_offset INTEGER NOT NULL,
      end_offset   INTEGER NOT NULL,
      text         TEXT NOT NULL,
      color        TEXT NOT NULL DEFAULT 'yellow',
      note         TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_highlights_reading ON highlights(reading_id, block_index);
  `)
}

export function resolveReadingById(id: number): ReadingMeta | null {
  return (
    (getDb().prepare('SELECT * FROM readings WHERE id = ?').get(id) as ReadingMeta | undefined) ?? null
  )
}
