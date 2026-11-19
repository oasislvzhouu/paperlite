/** 逐页比对：PDF 原生文本 vs 重排块文本（缺失/多余/重复 n-gram） */
import fs from 'node:fs'
import path from 'node:path'
import m from 'mupdf'
import { extractReflowBlocksMupdf } from '../src/renderer/src/reflow.ts'
import { DatabaseSync } from 'node:sqlite'

const DB = path.join(process.env.APPDATA, 'paperlite', 'paperlite.db')
const db = new DatabaseSync(DB)
const ids = process.argv.slice(2).map(Number)
const rows = db.prepare(`SELECT id,title,file_path FROM readings`).all().filter((r) => !ids.length || ids.includes(r.id))

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim().split(/\s+/).filter(Boolean)
const shingles = (toks, n = 8) => {
  const set = new Map()
  for (let i = 0; i + n <= toks.length; i++) {
    const k = toks.slice(i, i + n).join(' ')
    set.set(k, (set.get(k) ?? 0) + 1)
  }
  return set
}

for (const r of rows) {
  if (!fs.existsSync(r.file_path)) continue
  const doc = m.Document.openDocument(new Uint8Array(fs.readFileSync(r.file_path)), 'application/pdf')
  const pages = []
  const rawByPage = new Map()
  for (let i = 0; i < doc.countPages(); i++) {
    const pg = doc.loadPage(i)
    pages.push(pg)
    const st = JSON.parse(pg.toStructuredText().asJSON())
    const lines = []
    for (const b of st.blocks) for (const l of b.lines ?? []) {
      if (!l.text?.trim()) continue
      const y = l.bbox.y
      if (y < 50 || y > 750) continue
      lines.push(l.text)
    }
    rawByPage.set(i + 1, lines.join(' '))
  }
  const blocks = await extractReflowBlocksMupdf(pages)
  const byPage = new Map()
  for (const b of blocks) {
    if (b.kind === 'image') continue
    const arr = byPage.get(b.page) ?? []
    arr.push(b.text)
    if (b.textLines?.length) arr.push(b.textLines.map((t) => t.text).join(' '))
    byPage.set(b.page, arr)
  }
  const issues = []
  let totalMiss = 0
  let totalExtra = 0
  let totalDup = 0
  for (let p = 1; p <= doc.countPages(); p++) {
    const raw = norm(rawByPage.get(p) ?? '')
    const ours = norm((byPage.get(p) ?? []).join(' '))
    if (raw.length === 0 && ours.length === 0) continue
    const rawCount = new Map()
    for (const t of raw) rawCount.set(t, (rawCount.get(t) ?? 0) + 1)
    const ourCount = new Map()
    for (const t of ours) ourCount.set(t, (ourCount.get(t) ?? 0) + 1)
    let miss = 0
    for (const [t, c] of rawCount) miss += Math.max(0, c - (ourCount.get(t) ?? 0))
    let extra = 0
    for (const [t, c] of ourCount) extra += Math.max(0, c - (rawCount.get(t) ?? 0))
    const sh = shingles(ours)
    let dup = 0
    for (const [, c] of sh) if (c > 1) dup += c - 1
    totalMiss += miss
    totalExtra += extra
    totalDup += dup
    const missPct = raw.length ? miss / raw.length : 0
    const extraPct = ours.length ? extra / ours.length : 0
    if (missPct > 0.06 || extraPct > 0.06 || dup > 0) {
      issues.push({ p, miss, extra, dup, missPct: (missPct * 100).toFixed(0), extraPct: (extraPct * 100).toFixed(0) })
    }
  }
  const formula = blocks.filter((b) => b.kind === 'formula')
  const badFormula = formula.filter((b) => b.text.trim().length < 3)
  const tables = blocks.filter((b) => b.kind === 'table')
  const badTable = tables.filter((b) => !b.rect || b.rect.y1 - b.rect.y0 < 30 || b.text.trim().length < 12)
  console.log(`\n=== ${r.id} ${r.title.slice(0, 50)}  pages=${doc.countPages()}  miss=${totalMiss} extra=${totalExtra} dup=${totalDup}`)
  console.log(' pages:', issues.slice(0, 40).map((x) => `p${x.p}(m${x.missPct}% e${x.extraPct}% d${x.dup})`).join(' ') || 'ok')
  if (badFormula.length) console.log(' badFormulas:', badFormula.map((b) => b.page + ':' + JSON.stringify(b.text.slice(0, 24))).join(' | '))
  if (badTable.length) console.log(' badTables:', badTable.map((b) => `${b.page}:rect${b.rect ? Math.round(b.rect.y1 - b.rect.y0) : 0}:${JSON.stringify(b.text.slice(0, 22))}`).join(' | '))
}
