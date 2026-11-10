/** 把原件重新导入 PaperLite（等价于 UI 导入：复制到 library + 写 readings 行） */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const SRC_DIR = 'C:/Users/admin/Desktop/论文下载/downloads/2026-10-28/ieee'
const LIB = 'C:/Users/admin/AppData/Roaming/paperlite/library'
const DB = 'C:/Users/admin/AppData/Roaming/paperlite/paperlite.db'

const files = [
  'A Comparative Study of Machine Learning and Deep Learning Models for F.pdf',
  'A Novel Multiscale Residual Active Deep Q-Learning Network for Intelli.pdf',
  'Trainable Pseudo-Label Generator With Reinforcement Learning for Indus.pdf'
]

fs.mkdirSync(LIB, { recursive: true })
const db = new DatabaseSync(DB)
const now = new Date().toISOString()
for (const f of files) {
  const src = path.join(SRC_DIR, f)
  if (!fs.existsSync(src)) { console.log('MISSING', src); continue }
  const buf = fs.readFileSync(src)
  const sha = crypto.createHash('sha256').update(buf).digest('hex')
  const dest = path.join(LIB, `${sha}.pdf`)
  if (!fs.existsSync(dest)) fs.copyFileSync(src, dest)
  const dup = db.prepare('SELECT id FROM readings WHERE sha256 = ?').get(sha)
  if (dup) { console.log('already imported:', f, 'id', dup.id); continue }
  const title = path.basename(src).replace(/\.pdf$/i, '')
  const res = db.prepare(
    `INSERT INTO readings (title, file_path, original_name, size_bytes, sha256, added_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(title, dest, path.basename(src), buf.length, sha, now)
  console.log('imported:', f, 'id', Number(res.lastInsertRowid))
}
console.log('rows:', db.prepare('SELECT id,title,size_bytes FROM readings').all())
