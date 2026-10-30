import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'
import { viteStaticCopy } from 'vite-plugin-static-copy'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    base: './',
    resolve: {
      alias: { '@': resolve('src/renderer/src') }
    },
    plugins: [
      // pdf.js 的 CJK cmaps 和标准字体，离线随包分发（中文文献必备）
      viteStaticCopy({
        targets: [
          { src: '../../node_modules/pdfjs-dist/cmaps/*', dest: 'assets/cmaps' },
          { src: '../../node_modules/pdfjs-dist/standard_fonts/*', dest: 'assets/standard_fonts' }
        ]
      })
    ]
  }
})
