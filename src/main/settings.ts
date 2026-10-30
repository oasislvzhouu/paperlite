import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LlmSettings {
  baseUrl: string
  apiKey: string
  model: string
}

export interface AppSettings {
  llm: LlmSettings
}

const DEFAULTS: AppSettings = {
  llm: {
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    apiKey: '',
    model: 'glm-5.3-flash'
  }
}

const settingsPath = (): string => join(app.getPath('userData'), 'settings.json')

export function loadSettings(): AppSettings {
  try {
    if (!existsSync(settingsPath())) return { ...DEFAULTS }
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf-8')) as Partial<AppSettings>
    return {
      llm: {
        ...DEFAULTS.llm,
        ...(raw.llm ?? {}),
        baseUrl: raw.llm?.baseUrl || DEFAULTS.llm.baseUrl,
        model: raw.llm?.model || DEFAULTS.llm.model
      }
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(s: AppSettings): void {
  writeFileSync(settingsPath(), JSON.stringify(s, null, 2), 'utf-8')
}
