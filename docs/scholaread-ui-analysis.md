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

## 已知未做

- 引用角标转链接（需解析引用文本来做跳转）
- 右侧 AI/笔记侧栏（当前笔记走弹窗）
- 多色高亮批注面板（现为黄/绿/蓝三色）
