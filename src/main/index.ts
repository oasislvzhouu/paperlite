import { app, BrowserWindow, dialog, Menu, net, protocol } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
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

/** 中文应用菜单（替换 Electron 默认英文菜单） */
function registerMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '新建窗口', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'forceReload', label: '强制刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 PaperLite',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: '关于',
              message: 'PaperLite v0.1.0',
              detail: '轻量文献阅读器：重排阅读 · 公式 LaTeX · AI 双语翻译',
              buttons: ['确定']
            })
          }
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

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
  registerMenu()
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
