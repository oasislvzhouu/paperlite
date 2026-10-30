// 最小协议验证：注册 paperlite:// 并 fetch，观察是否 resolve/reject/hang
const { app, protocol, net } = require('electron')
const { pathToFileURL } = require('node:url')
const path = require('node:path')
const fs = require('node:fs')

const thumbsDir = path.join(app.getPath('userData'), 'thumbs')
const missing = path.join(thumbsDir, '1.png')
const existing = path.join(thumbsDir, 'exists.png')
fs.mkdirSync(thumbsDir, { recursive: true })
fs.writeFileSync(existing, Buffer.from('89504e470d0a1a0a', 'hex')) // PNG 头几个字节

protocol.registerSchemesAsPrivileged([
  { scheme: 'paperlite', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

app.whenReady().then(() => {
  const withCors = (res) =>
    new Response(res.body, {
      status: res.status,
      headers: { ...Object.fromEntries(res.headers.entries()), 'Access-Control-Allow-Origin': '*' }
    })

  protocol.handle('paperlite', async (req) => {
    try {
      const u = new URL(req.url)
      if (u.hostname === 'thumb') {
        const p = u.pathname.includes('ok') ? existing : missing
        console.log('[probe] handler 请求:', req.url, '→', p)
        return withCors(await net.fetch(pathToFileURL(p).toString()))
      }
      return new Response('nf', { status: 404 })
    } catch (e) {
      console.log('[probe] handler 抛错:', e.message)
      return new Response('err', { status: 500 })
    }
  })

  const t0 = Date.now()
  const timer = setTimeout(() => {
    console.log(`[probe] 超时 8s：fetch 从未 settle`)
    app.exit(2)
  }, 8000)

  net.fetch('paperlite://thumb/ok').then(async (r) => {
    console.log(`[probe] 存在的文件: status=${r.status} len=${(await r.arrayBuffer()).byteLength} (${Date.now() - t0}ms)`)
    return net.fetch('paperlite://thumb/missing')
  }).then(async (r) => {
    console.log(`[probe] 缺失的文件: status=${r.status} (${Date.now() - t0}ms)`)
    clearTimeout(timer)
    app.exit(0)
  }).catch((e) => {
    console.log(`[probe] fetch reject: ${e.message} (${Date.now() - t0}ms)`)
    clearTimeout(timer)
    app.exit(1)
  })
})
