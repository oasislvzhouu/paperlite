# PaperLite

轻量文献阅读器 —— 自研实现（Electron + Vite + pdf.js + better-sqlite3），功能对标商业文献阅读工具，代码与资产全部原创，仅使用开源组件。与任何商业产品无关联。

## 功能（Phase 1 + 2）

- PDF 导入（多选、SHA-256 去重、拷贝入库）
- 书架：缩略图（首页自动生成）、标题搜索、页数/大小/阅读进度展示
- 阅读器（原版模式）：pdf.js 渲染、翻页（按钮/键盘）、缩放（按钮/Ctrl+滚轮）、适应宽度
- **重排引擎（排版模式）**：PDF 固定版面 → 流式排版文章视图
  - 文本抽取 → 行重建（基线聚类 + 栏间距水平切分）→ 双栏检测与阅读顺序 →
    段落合并（段距/缩进/字号变化）→ 标题识别（字号阈值）→ 页眉页脚/页码过滤 → 连字符合并
  - 字号调节（A−/A＋）、页码分隔标记、滚动自动同步页码与进度
  - 无文字层（扫描件）自动回退原版模式并提示
- 阅读进度记忆（双模式共用，重开自动定位）
- 移出书架（含本地文件清理）

## 测试

```bash
npm run fixtures     # 重新生成双栏测试 PDF（纯 Python，无依赖）
npm run test:reflow  # Node 24 原生跑 TS 引擎：8 项断言（栏序/段落/页眉过滤/连字符…）
```

## 架构

```
src/
├─ main/        主进程：窗口、better-sqlite3、IPC、paperlite:// 自定义协议（PDF/缩略图安全分发）
├─ preload/     contextBridge 单一出口 window.paperlite
├─ renderer/    Vite + 原生 TS：书架 + pdf.js 阅读器（含 CJK cmaps 离线分发）
└─ shared/      跨进程类型
```

## 开发

```bash
npm install
npm run dev        # 开发模式（热更新）
npm run typecheck  # 类型检查
npm run smoke      # 构建后冒烟启动（2 秒自退，验证原生模块/窗口/DB）
```

## 数据位置

`%APPDATA%/paperlite/`：`paperlite.db`（SQLite）、`library/`（PDF 文件，按 sha256 命名）、`thumbs/`（首页缩略图）。

## 路线图

- [x] Phase 1 阅读器骨架
- [x] Phase 2 重排引擎（自研：pdf.js 文本抽取 + 栏/段落重建）
- [ ] Phase 3 标注与笔记
- [ ] Phase 4 AI 研读（LLM API）
- [ ] Phase 5 文献元数据（Crossref/arXiv）+ Zotero
- [ ] Phase 6 账号与同步后端
