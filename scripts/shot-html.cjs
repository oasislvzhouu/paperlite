/** 用 Electron 离屏渲染任意本地 HTML 并截图 */
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const htmlPath = process.argv[2]
const outPath = process.argv[3]
const width = Number(process.argv[4] || 900)
const height = Number(process.argv[5] || 1200)

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: { offscreen: true, javascript: true }
  })
  await win.loadFile(path.resolve(htmlPath))
  await new Promise((r) => setTimeout(r, 1200))
  const img = await win.webContents.capturePage()
  fs.writeFileSync(outPath, img.toPNG())
  console.log('captured', outPath, img.getSize())
  app.quit()
})
