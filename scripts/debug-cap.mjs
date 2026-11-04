import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/renderer/src/reflow.ts', import.meta.url), 'utf-8')
const line = src.split('\n').find((l) => l.includes('const CAPTION_RE'))
console.log('文件中的正则行:', line.trim())
const m = line.match(/CAPTION_RE = (\/[^/]+(?:\/[^/]+)*\/i)/)
const re = new RegExp(m[1].slice(1, -2), 'i')
console.log('test Fig.2:', re.test('Fig. 2. Training process of the DQN model.'))
