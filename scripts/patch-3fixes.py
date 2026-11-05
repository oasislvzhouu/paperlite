p = r'C:\Users\admin\Desktop\逆向工程\paperlite\src\renderer\src\reflow.ts'
s = open(p, encoding='utf-8').read()

# ── 修复 1：孤立碎片改用内容判据（不依赖字号）──
old1 = """    // 孤儿上下标碎片：整行都是小字号（公式的下标散件，如 7pt 的 "t"/"u trn"）
    // → 并入前一块；含数学特征的中短碎片行（display 公式的下标聚合行）并入前公式块
    const tinyDebris =
      l.fontSize > 0 &&
      l.fontSize < bodySize * 0.85 &&
      !l.eqNumbered &&
      (l.text.replace(/\\s/g, '').length <= 12 ||
        (l.charMathRatio >= 0.12 && l.text.length <= 80))"""
new1 = """    // 孤立碎片（内容判据，不依赖字号——MuPDF 的 bbox.h 与正文接近：
    // ① 极短无标点孤立行（"t"、"u trn"）② 含希腊/数学符号的短行
    // （"L(πθ), the optimization of L(πθ)"）→ 并入前块
    const stripped = l.text.replace(/\\s/g, '')
    const isOrphanShort =
      !l.eqNumbered &&
      stripped.length <= 3 &&
      /^[A-Za-z]$/.test(stripped)
    const isGreekShort =
      !l.eqNumbered &&
      l.text.length <= 60 &&
      /[\\u0370-\\u03FF]/.test(l.text) &&
      (l.text.match(/[A-Za-z]{4,}/g) ?? []).length <= 3
    const tinyDebris = isOrphanShort || isGreekShort"""
assert old1 in s, 'debris block not found'
s = s.replace(old1, new1)

# ── 修复 2：公式判定优先于标题（含等号/数学符号的行不可能是标题）──
old2 = """    const heading = !isFormulaLine(l) && !l.eqCollect && (isHeadingSize(l.fontSize) || isSectionHeadingLine(l))
    const kind: 'heading' | 'paragraph' | 'formula' =
      l.eqCollect || isFormulaLine(l)
        ? 'formula'
        : heading
          ? 'heading'
          : 'paragraph'"""
new2 = """    // 公式优先：含等号/数学符号/Greek 的行即使 bbox 偏大（上下标撑高）也不是标题。
    // 典型误判："optimal policy θopt = arg max" 曾被当作大标题
    const looksMathy =
      /[=⊕∘∇]/.test(l.text) || /[\\u0370-\\u03FF]/.test(l.text) || l.eqNumbered
    const headingEligible =
      !isFormulaLine(l) && !l.eqCollect && !looksMathy
    const heading =
      headingEligible && (isHeadingSize(l.fontSize) || isSectionHeadingLine(l))
    const kind: 'heading' | 'paragraph' | 'formula' =
      l.eqCollect || isFormulaLine(l)
        ? 'formula'
        : heading
          ? 'heading'
          : 'paragraph'"""
assert old2 in s, 'heading block not found'
s = s.replace(old2, new2)

open(p, 'w', encoding='utf-8').write(s)
print('fixes 1+2 applied')
