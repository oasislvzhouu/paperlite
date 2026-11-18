# Scholaread 阅读层 UI 对标分析（静态逆向）

来源：`%LOCALAPPDATA%/Programs/scholaread/resources/render/assets/`
- `index-9602fedb.css`（5.7KB）— 阅读视图专用样式
- `index-cb13a4e8.css`（850KB）— 设计令牌 `--srd-*`
- `main-30786122.js` — 阅读容器 CSS 变量注入

## 设计令牌（节选）

| 类别 | 浅色 | 深色 |
|---|---|---|
| 背景 1/2/3 | `#fff` / `#fafafa` / `#eee` | `#121212` / `#2c2c2c` / `#393939` |
| 文字 1/2/3 | `#121212` / `#666` / `#b2b2b2` | `#dcdcdc` / `#eee` / `#b2b2b2` |
| 主色 | `#3330e4`（强调 `#6059f0`） | `#6059f0`（浅 `#b9b0ff`） |
| 护眼/纸色 | `#ad8e70` | — |
| 链接 | `#6059f0` | `#b9b0ff` |

## 阅读排版

```css
.pdf_paragraph { margin-top: 1.5em; line-height: 1.4 }
.pdf_paragraph_translation {
  margin-top: .5em; line-height: 1.6;           /* 桌面端 1.8 */
  text-decoration: underline dotted #aaa;        /* 译文签名样式 */
  text-underline-offset: 4px;
  text-decoration-skip-ink: none;
}
.no-reflow-formula { padding: 6px 0 8px; border-radius: 4px;
  background: var(--srd-background-color-2);     /* 公式面板 */
  --formula-w: min(var(--region-w), 500); }      /* 宽度上限 500，等比缩放 */
.no-reflow-table, .no-reflow-image { margin-top: 16px; cursor: zoom-in }
html.srd-dark .formula-container .bi0 {
  filter: invert(100%) sepia(100%) saturate(1000%) hue-rotate(180deg) }  /* 暗色反色 */
.pdf_reference { color: var(--srd-link-color-1); cursor: pointer }
```

容器变量（`main-*.js` 注入 `#pages-container`）：
`--paper-container-width`、`--reader-zoom`、`--reader-font-size`、
`--reader-font-family`（`var(--font-<key>)`）、`--psf-scale`。

可选字体：EB Garamond / Linux Libertine / Lato / Open Sans / Poppins /
Montserrat / JetBrains Mono / Noto Sans Mono / Arial + 中文书法字体。

## PaperLite 已对齐 / 已超越

| 维度 | Scholaread | PaperLite（本轮） |
|---|---|---|
| 主题 | 浅 / 深 | **深 / 浅 / 护眼**（+ `#ad8e70` 主色） |
| 主色 | 紫罗兰 | 紫罗兰（`#8b84ff` / `#4f46e5`） |
| 译文 | 点线下划线 | **双模：下划线 / 色块** |
| 行高 | 1.4（正文）/1.8（译文） | 可调 1.3–2.2（默认 1.75） |
| 字号 | 可缩放 | 可缩放 + 持久化 |
| 字体 | 10+ 内嵌字体 | 4 组本地字体栈 |
| 公式 | 面板 + 等比缩放 + 暗色反色 | **紧包围盒裁图 + 反色 + screen 混合**（暗色下与正文融合，无白块） |
| 图表 | `cursor: zoom-in` | **点击灯箱放大**（再点切原始像素） |
| 表注重复 | — | 裁图内重复文字自动剔除 |

## 交互层（main-*.js 挖掘）

| 其实现 | 说明 | PaperLite 现状 |
|---|---|---|
| `ReaderButtonFormulaToolbar` / `ReaderButtonImageToolbar` | 给每个 `.no-reflow-formula` / `.no-reflow-image` 注入悬浮按钮（问 AI） | ✅ 悬浮条：放大/复制/下载/**AI 解释** |
| `ReaderPopupPaperInfo` | 论文信息：阅读时长、进度、导出 BibTeX/EndNote | ✅ 已实现（含累计阅读时长） |
| `ReaderTargetLanguageSelect` | 译文目标语言 | ✅ 简/繁/英/日/韩 |
| `ReaderMajorPointsPanel` | AI 提取论文要点（objective/method/novelty/result）并可按类型筛选 | ⛔ 未做（需 LLM 结构化抽取 + 面板） |
| `ReaderPopupExportPdf` | 导出带高亮/笔记的 PDF | ⛔ 未做（需注释写入层） |
| `ReaderPopupAIAnswer` | 划词 AI 问答（浮层/侧栏两种模式） | ⛔ 未做 |

## 已知未做

- AI 要点面板（MajorPoints）与划词 AI 问答
- 导出带批注的 PDF
- 引用角标在原文模式下的点击（重排模式已支持）

## 排版内核（本地转换产物实证）

缓存位置：`%APPDATA%/scholaread/files/out/<引擎版本>/<pdf-md5>/server/`
每篇论文一套：`paragraph_index.json`、`catalogue_index.json`、`figure_index.json`、
`pN_slice.txt`，以及每页目录 `1/index.html` + `1/index.css`（字号/定位类 + 内嵌字体）。
引擎为 pdf2htmlEX 系（记忆中的 pdf2htmlEX.wasm + Pyodide），再做语义后处理。

### 语义文本块（可重排）

```html
<div class="pdf_paragraph pdf_heading ffd00000000 adjustable_fs6" data-pa-id="pa_1_1">
  <span class="sentence ffd00000000" text_lines_identification="<base64>">文字…</span>
</div>
<div class="pdf_paragraph_separator"></div>
```

- `adjustable_fsN` / `adjustable_mlN` 来自 `pN_slice.txt`：
  `{"fontSize":{"adjustable_fs5":20.0,"adjustable_fs6":15.0,"adjustable_fs7":12.5},
    "marginLeft":{"adjustable_ml0":0.00075,"adjustable_ml1":0.99976}}`
  → **字号 = PDF 原始 pt 直接作为 px**（正文 12.62、节标题 15.0、论文标题 19.92），
  各级标题不做固定 em 阶梯；`marginLeft` 是几何微调（≈1px），非首行缩进。
- 段落间距靠 `.pdf_paragraph{margin-top:1.5em}` + 分隔块 `.pdf_paragraph_separator{height:1.5em}`。
- 行高 1.4（正文）/1.3（caption 类 `.pdf_intro`）/1.8（译文）。
- **无 text-indent、无 justify、无 hyphens**：段距分段、左对齐自然折行。
- `-cross` 后缀标注跨栏/跨页段落（引擎判定，非启发式）。
- `<span class="sentence">` 每句一个，带 `text_lines_identification`（base64 的
  行 id→页码/起止偏移映射），用于句子级定位与 AI 引用。

### 原子块（原版面保真）

```html
<div class="no-reflow-author" data-region-w="383.19" data-region-h="9"
     style="width:calc(var(--client-width));height:calc(9px/383.19*var(--client-width))">
  <div style="transform:scale(calc(var(--client-width)/383.19))">
    <div class="bi0 bp0 bgs0"></div>                     <!-- 背景切图 -->
    <div class="m0 x3 top0 h1 fs0 fc0 ls0 ws0">文字</div>  <!-- 逐行绝对定位 -->
  </div>
</div>
```

- 背景切图内嵌为 base64 PNG（`.bi0{background-image:url(data:image/png;base64,…)}`），
  文字以 `position:absolute; white-space:pre` 逐行叠在上面
  → **像素级还原 + 文字仍可选中/复制**，整体按 `--client-width` 等比缩放。
- 公式：`.no-reflow-formula{--region-w/--region-h/--region-scale}` +
  `aspect-ratio`，宽度 `min(region-w, 500px)`。

### 字体

- 每篇的 `index.css` 内嵌 **原文子集字体**（`@font-face{src:url(data:font/woff;base64,…)}`，
  族名如 `pf1-ff353…`），因此字形与 PDF 完全一致。
- 阅读设置可替换为其它字体（`--reader-font-family`），字号整体乘 `--reader-font-size`。

### PaperLite 对标结果

| 维度 | Scholaread | PaperLite（Phase 4.2） |
|---|---|---|
| 标题字号 | PDF 原始比例 | ✅ 取 `firstFontSize/bodySize` 作为 em 内联 |
| 行内粗体/斜体 | 原文 span | ✅ MuPDF `asHTML` 逐行对齐（60/60、113/113）保留 `<b>/<i>/<sup>/<sub>` |
| 段落风格 | 无缩进 + 左对齐 + 段距 | ✅ 新增「学术/中文」预设，默认学术 |
| 行高 | 1.4 正文 / 1.3 caption | 可调 1.3–2.2（默认 1.75→可按需 1.5） |
| 字体 | 原文子集字体内嵌 | 随包 EB Garamond/Libertine/Lato/Open Sans（非原文） |
| 原子块 | 背景切图 + 可选中文字 | 截图像素（文字不可选） |
| 跨栏段落 | 引擎 `-cross` 标注 | 几何启发式（列锚评分） |
