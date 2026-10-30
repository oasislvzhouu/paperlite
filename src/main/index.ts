import { app, BrowserWindow, net, protocol } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { initDb, resolveReadingById, thumbPath } from './db'
import { registerIpc } from './ipc'

// 必须在 app ready 之前注册：让 paperlite:// 支持 fetch/流式（pdf.js 依赖）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'paperlite',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: 'PaperLite',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) mainWindow.loadURL(devUrl)
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  // 把渲染层 console（含未捕获异常）转发到主进程 stdout，便于诊断
  mainWindow.webContents.on('console-message', (_e, _level, message) => {
    console.log(`[renderer] ${message}`)
  })
  mainWindow.on('closed', () => (mainWindow = null))
}

/** paperlite://pdf/<id> 与 paperlite://thumb/<id>：只按数据库登记的路径吐文件 */
function registerPaperliteProtocol(): void {
  // 渲染页源自 file://（origin null），取 paperlite:// 属跨源；补 ACAO 头放行 pdf.js 的 fetch
  const withCors = (res: Response): Response =>
    new Response(res.body, {
      status: res.status,
      headers: { ...Object.fromEntries(res.headers.entries()), 'Access-Control-Allow-Origin': '*' }
    })

  protocol.handle('paperlite', async (request) => {
    try {
      const u = new URL(request.url)
      const id = Number(/^\/(\d+)/.exec(u.pathname)?.[1])
      if (!Number.isInteger(id) || id <= 0) {
        return new Response('bad request', { status: 400 })
      }
      if (u.hostname === 'thumb') {
        return withCors(await net.fetch(pathToFileURL(thumbPath(id)).toString()))
      }
      if (u.hostname === 'pdf') {
        const row = resolveReadingById(id)
        if (!row) return new Response('not found', { status: 404 })
        return withCors(await net.fetch(pathToFileURL(row.file_path).toString()))
      }
      return new Response('unknown host', { status: 404 })
    } catch {
      return new Response('internal error', { status: 500 })
    }
  })
}

app.whenReady().then(() => {
  initDb()
  registerPaperliteProtocol()
  registerIpc()
  createWindow()

  // 冒烟模式：启动 2 秒后自退，用于验证原生模块加载与窗口创建（CI/自动化）
  if (process.argv.includes('--smoke')) {
    setTimeout(() => {
      mainWindow?.destroy()
      app.exit(0)
    }, 2000)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
