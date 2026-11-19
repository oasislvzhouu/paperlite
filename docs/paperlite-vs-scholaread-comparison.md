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

---

## 第三篇：MDPI 单栏（Sensors 2017, 17, 425）

样本：**A New Deep Learning Model for Fault Diagnosis with Good Anti-Noise
and Domain Adaptation Ability on Raw Vibration Signals**（21 页，单栏，
逐段首行缩进 21pt、列表悬挂缩进、公式为矢量图）。Scholaread 产物
`cmp/sc3-p1..p6.png`，PaperLite 截图 `cmp/ours3-p1..p6.png`。

单栏页暴露出与双栏不同的 6 类问题：

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 标题被拆成 h1 / 正文 / h1 三段，中间行变小且带分隔线 | 标题续行以 "with" 小写开头被排除出标题；`mergeHeadingContinuation` 又跳过 level 1，且只吸收一行 | 一级标题允许同字号续行（大写/小写均可，挡编号/句末/长正文）；合并后用 `lastTop` 继续吸收第 3、4 行 |
| 2 | 作者行、`Abstract:`、`Keywords:` 全被渲染成 h3 | 粗体即标题的规则没有长度上限（MDPI 这些行都是粗体） | 粗体标题要求 ≤60 字符 |
| 3 | 每段第二行都被拆成新段（第 3 页 "named Deep / Convolution…"） | flush-left 基线把 21pt 段落缩进当成第二栏基线 | 基线间距阈值从 20pt 提到 `max(20, 5×bodySize)` |
| 4 | 列表项 `(1) …` 的续行独立成段 | 悬挂缩进被当成段首缩进 | `bufIsList` 期间不触发缩进断段 |
| 5 | `…Section 2.` 与 `The intelligent…` 被拆段 | 同一视觉行被字体切换拆成两条同 y 行，未合并 | 同 y、同栏基线、横向紧邻的正文片段直接拼回（不参与分段） |
| 6 | 页眉 `2 of 21` 并入正文；公式 (5)(6)(7) 全掉到页尾 | 页码正则不认 "N of M"；公式碎片簇被当成边栏（avgW<15% 且 ≥3 行）整组移到页尾 | 页码加 `\d+ of \d+`；数学行不参与边栏判定 |
| 7 | 公式 (5) 分子 `ezj` 单独成段、裁图被切掉分子 | 分子行在公式簇 bbox 之上，未进簇 | 新增 `absorbFormulaFragments`：紧贴裁图、x 重叠的 ≤10 字符无空格段落并入 rect 并删除 |
| 8 | 标题对齐（左/居中）判断错 | 只有 `left≤60` 的兜底 | 块级 `align`：多行标题按各行 x0 是否一致判定；合并标题时按两段 left 是否相同更新 |

复测：第 1/3/6 页结构与 Scholaread 一致；公式 (1)(5)(6)(7) 完整（含分子），
列表项、二级标题 `2.1.` 独立。两边都缺 MDPI 的矢量插图（Fig.1-3 在其转换
产物里也是破图），属共同限制。

---

## 第四批：4 篇不同版式抽查（Springer / ICLR / Eksp / MDPI）

从 Scholaread 的 75 篇已转换论文里再取 4 篇导入本库（reading 10–13），
只对照第 1–2 页的首页/阅读序，记录通用性修复：

| 论文 | 版式 | 主要问题 | 修复 |
|---|---|---|---|
| A performance-interpretable intelligent fusion…（Nonlinear Dyn, Springer, 38p） | 首页通栏标题 + 双栏摘要/关键词 | 期刊名前导块字号最大被当标题；标题第三行 "CAME" 独立成 h1；"1 Introduction"（数字后无点）没识别 | 先标记报头 meta 再合并标题；标题碎片按 y 序合并；`SECTION_HEADING_RE` 支持 `1 Introduction` |
| TIME-LLM（ICLR 2024, 24p） | 单栏会议论文 | 作者/单位/邮箱/`ABSTRACT` 粘成一段；章节号 "1" 单独一行被当页码删掉；作者脚注混入正文 | 首页作者/单位/邮箱/ABSTRACT 标签强制分段；页码只删页边 7%；`equal contribution/corresponding author` 视为 footer/meta |
| An Explainable and Adaptive Anomaly Detection…（Eksp. i Niezawodnosc, 18p） | 首页左 Highlights / 右 Abstract 并排 + 下方通栏正文 | 期刊报头/Volume/Indexed by 当正文；标题第二行被拆走；摘要首行被高亮条目吞并；ORCID 脚注混入引言；单位尾行重复 | 报头/citation/ORCID 规则；标题碎片按 y 合并；散文片段同 y 合并的横向阈值收紧到 1.2×字号（栏间距 23pt 不再误拼）；单位尾行并入最近单位块（去重） |
| Multimodal LLM-Based Fault Detection…（MDPI Electronics, 30p） | MDPI 单栏 | `* Correspondence:` 被当标题；Citation/Electronics 页脚行混入正文；6pt 引用块游离 | Correspondence 不判标题；`Citation:`/`Electronics YYYY`/`www.mdpi.com` 加入 footer/meta；≤6pt 首页小块视为 meta |

**共性修复**：
- 首页 meta（报头/版权/收稿日期）统一移到第 1 页末尾，不再插在标题与作者之间；
- 短碎片尾合并规则增加豁免：邮箱行、`ABSTRACT/Keywords/Highlights` 标签、单位角标行、equal contribution 脚注；
- 页脚行不得跨页续接（`e-mail:` 行曾把下一页首句吞进 meta）；
- 清理了源码里 4 处被 heredoc 转义破坏成 0x08 的正则（`VOL`/`keywords`/`issn`/`correspondence`），
  这类损坏会让规则静默失效——本次 Eksp 的报头识别失败即由此暴露。

**仍存在**：MDPI 矢量插图双方都缺；MDPI2 的 `Electronics 2024…` 页脚行仍会并进引言首段一行（后续
需在 block 级按 footer 前缀拆分）；Eksp 正文在 PDF 页边界处断段（连续重排的取舍）。

---

## 第五轮：按 Scholaread 产物结构修复剩余项

深挖其转换产物（`server/N/` 下的 `region.json`、`index.html`、`index.css`、
`paragraph.json`）：

- **`region.json` 是版面区域清单**：每条有 `x/y/width/height/id/order/type`
  （title/author/text/…）。MDPI Sensors 第 1 页只有 10 条 **text** 区域，
  Fig.1 所在的 y≈330–430 区域完全缺失——说明**其转换器同样丢弃矢量插图**，
  不是我们截图的资源路径问题（`server/1` 里仅 `bg1.png/jpg` 页面底图）。
  这确认了"矢量图缺失"是双方共同限制；后续若要补，需要我们自己做矢量
  绘图算子的栅格化。
- **其段落是页内建模**：`paragraph.json` 按页组织，跨页句子用
  `cross_page` 标记而不是合并段落。PaperLite 是连续重排，跨页段落应合并
  ——但页脚/ORCID 元信息会卡在页边界，导致正文被截断。

据此做的修复：

1. **跨页段落续接**：上一页正文段未以 `.!?;:` 结尾、下一页首段小写/括号
   开头 → 合并，允许页脚 meta 夹在中间（Eksp 第 1→2 页正文恢复连续）。
2. **同页被 meta 隔断的段落**：MDPI 引言被 `Electronics 2024…` 页脚切成
   两段 → 跨 meta 合并；`(FDD)` 结尾不再视为句末。
3. **局部并排区域**：按 x0 聚簇（只用 ≥3 行的主簇，避免页码/编号单行簇
   打断），以"结束于右簇之前"的行的最大 x1 计算栏距，左栏读完再读右栏。
   修复 MDPI 左元数据（Received/Accepted/版权）与右正文按 y 交错的问题，
   `trans- forming`、`advent of Industry / 4.0` 等跨行/跨栏断词也随之消失。
4. **meta 识别扩展**：`Electronics YYYY`、`Citation:`、`doi.org/`、`www.mdpi.com`、
   `Licensee MDPI`、`ORCID` 归入页脚/元信息，不再并入正文或作者块。
5. **合并函数支持连字符**：跨页/跨 meta 合并时若前段以 `-` 结尾且后段
   小写开头，去连字符直拼（`trans-`+`forming` → `transforming`）。

复测：MDPI2 第 1 页标题/作者/单位/邮箱/Correspondence/Abstract/Keywords/
Introduction 全部正确，引言连续；Eksp 第 1 页摘要/Highlights/关键词/正文
顺序正确，第 2 页首段与第 1 页末段连续。

---

## 第六轮：图表/公式全页目检（MDPI 21 页）

不是只看第一页：把 MDPI Sensors 的公式页（3/4/6/13/15）和表格/算法页（8/13）
逐页截图目检，发现并修复：

### 公式

1. **列表编号被误当公式**：列表悬挂编号 `(1)` 与正文同基线，散文间隙收紧规则
   把两者拆开后，编号行被 `clusterFormulas` 当成 display 公式种子，页面出现
   四个巨大的 `(1)(2)(3)(4)` 裁图、列表文本丢编号。修复：编号行与同基线正文
   强制合并（`markerRow` 例外），并让局部栏检测忽略纯编号行。
2. **(2)(3) 式被拆成左右两半 + 编号分离**：两个公式块之间夹着短碎片段
   （`(j)`、`a` 等），块级合并因"不相邻"失效。新增 `mergeFormulaLines`：
   跨过 ≤20 字符无角色碎片（含 heading 碎片）合并同基线公式块，编号块也并入，
   并集矩形包含全部片段。
3. **行内数学句被裁成公式图**（MDPI "input to a BN layer x = (x(1),…)"）：
   编号锚定的向上收集把整句吸进公式。加"≥2 个普通英文词即停止"的散文守卫，
   再把已生成的散文公式块降级为正文。
4. 修完后 (1)-(4) 均为单张完整裁图（含编号），(3) 的 `p^{l+1}` 也并回裁图。

### 插图（矢量图）

`region.json` 证实 Scholaread 自己也不含矢量插图区域；我们做了它没有的：
**图注锚定的矢量图裁剪**——取图注上方、最后一个宽正文块（≥6 词且 ≥半栏）
到图注之间的区域，用文字块 bbox 只屏蔽正文、保留图内标签和矢量墨迹，
按非白像素求包围盒，再从 pdf.js 渲染的页面画布裁图。修复了三个关键坑：
- 该区域坐标是 top-down，而图片算子矩形是 bottom-up，初版翻转导致裁到
  图注下方正文；现按 top-down 直接裁。
- `cropPageImages` 在"无图片算子"时提前 return，矢量区域永远不执行 → 去掉
  该早退。
- 单页 pdf.js 算子列表卡死会拖住整本补图 → 每页 12s 护栏。
效果：MDPI Fig.1（三框架流程图）完整显示在图注上方；Fig.5/9/13/15/17/18 等
矢量图也补齐。

### 仍未解决（已知）

- **Table 3**：表体是矢量/松散文本，`isTableRow` 未通过，只把表注做成 1 行高
  的空裁图；表体文本散成段落。需要针对"表注 + 多列短单元格"放宽行判据。
- **Algorithm 1**（第 8 页）：裁剪右边界停在 ~x518（应到栏右缘 560），
  且算法体只截到 Input 公式；后续步骤成段落。
- **Fig.4 / Fig.9**：图区与算法/表格区域重叠，Fig.9 裁图仍把 Table 3 一并
  框入；需要先用表格区域把图区上界切干净。

---

## 第七轮：全篇逐页内容审计（8 篇，173 页）

用 `scripts/audit-content.mjs` 做逐页 token 对账（PDF 原生文本 vs 重排块文本，
含表格覆盖层文字），并按页目检图表/公式。结论：

- 全篇 token 覆盖率约 97%（Springer 38 页：raw 20918 / ours 20618），
  所谓“整页丢失”多为连续重排把下一页首段并进上一页块，或表格覆盖层文字
  未计入审计口径；已修正审计口径（计入 `textLines`）。
- 真实问题集中在三类：**参考文献跨页/编号分段**、**表格裁图只剩表注**、
  **算法框右边界过窄**。

本轮修复：

1. **数字编号参考文献独立成段**（MDPI/Springer `7. Lee, W.; …`）：每条
   `^\d{1,3}\.\s+[A-Z]` 强制 flush；参考文献不跨页续接。此前 MDPI 第 20 页
   77 行条目全部并进第 19 页一个 5507 字大段。
2. **单栏页判定只用宽正文行**：图内标签/公式编号不再把单栏页误判为双栏，
   MDPI Algorithm 1 裁图右边界从 x=293 恢复到 x=523（覆盖 Input 公式）。
3. **公式垃圾块过滤**：去掉只剩 `�` 的 1 字符公式块。
4. 表格 fallback 改为按行间空隙收集表体（含图注即断），避免只裁表注 26pt；
   但 MDPI Table 3 仍把 Figure 9 图注算进表格行（y1=578），说明该表进入的是
   另一条 rows 路径，尚未收口。

仍待处理（按优先级）：

- Table 3 / Table 5：表体行的 `isTableRow` 判据（多列短单元格）与图注边界；
- Algorithm 1：完整算法框（已扩右边，y1=520 仍可能截断后半）；
- 重复 n-gram：ICLR 第 7/8 页 d52/d20、MDPI 第 10/17 页 d19/d17，需定位是
  表格覆盖层/图注重复还是跨页合并重复。
