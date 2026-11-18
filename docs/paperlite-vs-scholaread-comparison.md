# PaperLite vs Scholaread 排版逐项对照（同篇实测）

## 样本与方法

- 样本：**MSF-DFormer: A Multisensor Multiscale Fusion Network With Deformable
  Transformer for Fault Diagnosis Under Complex Working Conditions With Limited
  Samples**（IEEE TIM 2025，18 页）
- Scholaread 侧：取其本地转换产物
  `%APPDATA%/scholaread/files/out/<ver>/<md5>/server/N/index.html + index.css`，
  拼接其阅读层关键 CSS（`.pdf_paragraph{margin-top:1.5em;line-height:1.4}`、
  原子块区域样式）后用 Electron 离屏渲染，内容宽 760px。
- PaperLite 侧：同一 PDF 导入本库，重排模式，内容宽 760px、浅色主题、
  「学术」段落预设、字号 16、行高 1.5。

## 对照结果：本轮修掉的差异（附实测根因）

| # | 现象（此前 PaperLite） | Scholaread | 根因 | 修复 |
|---|---|---|---|---|
| 1 | **第 2 页整页合成 1 段**（5674 字） | 5 段 | 段落首行缩进仅 **10pt**，旧阈值 `1.6×字号≈11.2pt` 漏掉 | 改为「按栏 flush-left 基线（x0 直方图众数）」判定，缩进 ≥2.5pt 即段首 |
| 2 | 双栏页把两栏拼进同一段 | 左栏读完接右栏 | 换栏处 x0 跳变被旧阈值排除，未强制分段 | 换栏即断段（除非上行连字符/下行小写续接） |
| 3 | `1) Sensor SCRM:` 吞掉后面整段 | 列表项独立成块 | 列表项前缀与长度绑定（>160 字不算列表项） | 列表前缀独立判定；列表项后遇 flush-left 大写行强制断段 |
| 4 | 摘要被切断（`…performs well in fus-`）+ 单位/版权插在中间 | 摘要为一整段 | 首页区域顺序错：作者/单位/版权与双栏摘要交错 | 首页版式重排：作者碎片合并、无数学内容 formula 降级、版权块后移、摘要跨栏续接（连字符直拼，单位/邮箱不参与） |
| 5 | 作者行被裁成**公式图**（`…Guo ( ) , Hua ( ) , Member, IEEE`） | 作者区整体文本 | 簇级判据未排除「括号+多逗号」的姓名行 | 簇级否决：无运算符 + ≥2 逗号 + 括号 → 不是公式 |
| 6 | `I. INTRODUCTION` 与正文粘成一行，且首字下沉丢字母（`B EARINGS`/`EARINGS`） | 标题独立，正文 `BEARINGS` | ①标题吞正文；②首字下沉（单字母 26pt）受"数学行门控"跳过合并；③合并后 `rich/html` 未同步 | ①标题块句末拆分；②drop cap 合并提前到门控之前并同步 text/html |
| 7 | 图注 `Fig. 1. …` 并进上段正文 | 图注独立一行 | 图注未参与断段 | `Fig./Figure/图 + 编号` 行强制断段 |
| 8 | 行距 1.75 / 字号 17（比原文松散很多） | 行距 1.4 / 字号=原文 pt | 默认值偏大 | 默认调至 16px / 1.55；「学术」预设对齐其"无缩进+左对齐+段距分段" |

## 对照后仍存在的差异（非 bug，属实现路径不同）

| 维度 | Scholaread | PaperLite | 说明 |
|---|---|---|---|
| 字体 | 每篇**内嵌原文子集 woff**（如 Formata/TimesLT），字形与 PDF 一致 | 按原文族名匹配随包字体（Formata→Lato，Times→EB Garamond），可关闭 | 真内嵌需 glyph→Unicode 重映射（FontForge 级），暂不做 |
| 公式外观 | 矢量字形 + 浅灰面板 + 等比缩放 | 3× 位图裁图（浅色下白底、深色下反色融合） | 我们的 (2) 式**完整**，它的 (2) 式在右边缘被裁掉；位图极限放大不如矢量 |
| 原子块文字 | 背景切图 + 定位文字，原生可选中 | 裁图 + **透明文字覆盖层**，可选中/复制 | 效果等价，实现不同 |
| 跨栏/跨页 | 引擎直接标注 `-cross` | 块级 `cross` 元数据（页/栏）+ 可选徽标 | 其标注来自转换服务，我们为几何判定 |
| 首字下沉 | 保留原字形大小 | 合并成整词（不放大） | 我们尚未做大字下沉的视觉呈现 |
| 段落对齐 | 左对齐、行高 1.4 | 默认左对齐（学术）/可切中文两端对齐 | 一致（可调） |

## 我们的优势项（同页对照可见）

1. **公式不被裁切**：Scholaread 的 (2) 式右边缘缺失；我们的裁图基于紧包围盒 + 像素扫描。
2. **深色模式**：公式/表格反色融合（`invert + contrast + screen`），其公式在深色下要额外反色规则且带灰面板。
3. **引用可点 + 反向高亮**：正文 `[n]` 链接、点条目反查全部引用位置；其仅有链接。
4. **原子块文字覆盖层**与灯箱/复制/下载/AI 解释一体。

---

## 第二篇：Elsevier 双栏首页（换一篇复测）

样本：**A sound-vibration physical-information fusion constraint-guided deep
learning method for rolling bearing fault diagnosis**（Reliability Engineering
and System Safety 253 (2025) 110556，24 页）。Scholaread 产物
`cmp/sc2-p1|p2.*`，PaperLite 截图 `cmp/ours2-p1|p2.png`。

这篇的首页版式与 IEEE 完全不同：顶部通栏标题/作者/单位，下面
`ARTICLE INFO`（左关键词）与 `ABSTRACT`（右摘要）并排，再往下才是
`1. Introduction` 起的双栏正文。旧管线在这里出现 4 类问题：

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 标题/作者/单位/摘要全部丢失 | `isNarrowFormula` 用 `fragCount≥5` 判"窄公式行"，而 MuPDF 管线里 `fragCount` 是**词数**——整段通栏摘要被当成窄公式，通栏行占比误判导致首页区域错乱 | 只认数学占比（`mathRatio/charMathRatio`），不再用 `fragCount` |
| 2 | 摘要被拆成 4 段并只取到 218 字尾段 | 阅读序在"左栏摘要 + 右栏正文"同 y 带处按行交错；摘要合并只取最长块 | 新增混合版式：先找最早的双栏证据行带 `cut`，其上方按通栏、下方按双栏；摘要区取 Introduction 之前所有同 x 带段落（含短尾行）拼成一段 |
| 3 | `A B S T R A C T` 与 `Keywords:` 粘成一段 | 字母间隔的版面标签未识别 | 剥离 `A B S T R A C T / A R T I C L E I N F O` 标签，关键词行单独成块 |
| 4 | `1. Introduction` 吞掉右栏首行（"bearing failures can prevent…"） | 两栏同一基线的行被当成标题续行 | 标题续行必须同栏（`|Δleft| ≤ 4×字号`）；标题不以连字符/破折号结尾 |
| 5 | 首页左右栏底部的通讯邮箱/doi/版权插进正文 | 页脚行与正文同属左栏 x 带 | 首页 foot 只在**左栏**且 y > 82% 页高时摘出，放到双栏之后；右栏正文可排到页底不受影响 |
| 6 | 作者行上标丢失（`You Keshun a, …`） | `asHTML` 的行 y 是基线、`asJSON` 的 bbox.y 是行顶，差 3–5pt，原 1.6pt 容差匹配不到富文本 | 按前缀/左边界筛选后取最近 y（容差 6pt），作者/单位上标恢复 |
| 7 | 断词连字符残留（`effi-ciency` / `tech-niques`） | 文本层已拼好词，但渲染用的 `html` 仍带连字符；旧逻辑只在 `</sub>/<sup>` 前删 | 断词/复合词按词表判定：去掉连字符后的词在文档中出现过 ⇒ 断词去连字符，否则保留（`frequency-domain`） |

复测结果：第 1 页与 Scholaread 的结构、段落边界一致；摘要完整、关键词独立、
Introduction 起双栏顺序正确，作者上标可见。第 2 页正文顺序、段落切分一致
（PDF 自身有一处重复句，双方都保留）。
