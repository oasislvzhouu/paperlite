/**
 * MuPDF 独立加载入口。
 *
 * mupdf/dist/mupdf.js 顶层有 `await libmupdf_wasm(...)`：
 *  - 直接静态导入 → 阻塞主模块图（应用启动卡死）
 *  - 动态 import('mupdf') → Vite 不打包裸说明符（运行时解析失败）
 * 解法：本包装模块静态依赖 mupdf，主代码动态导入本模块 →
 * Vite 将其拆为独立 chunk，仅在需要时加载。
 */
import * as mupdf from 'mupdf'

export { mupdf }
export default mupdf
