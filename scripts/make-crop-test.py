"""合成测试 PDF（IEEE 双栏版式）：复现裁图吞正文/切公式"""
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

OUT = r'C:\Users\admin\Desktop\逆向工程\paperlite\scripts\fixtures\crop-boundary.pdf'
W, H = letter
L0, L1 = 48, 296
R0, R1 = 316, 564

def body(c, x, y, text, size=9, leading=11.5):
    c.setFont('Times-Roman', size)
    for line in text.split('\n'):
        c.drawString(x, y, line)
        y -= leading
    return y

c = canvas.Canvas(OUT, pagesize=letter)
mid = (L0 + L1) / 2

y = H - 56
y = body(c, L0, y, 'Fault diagnosis of rotating machinery is a fundamental task\n'
                   'in industrial maintenance. Deep learning has been widely\n'
                   'adopted for this purpose over the past decade, and many\n'
                   'variants have been proposed for vibration classification.')
y -= 14
c.setFont('Times-Roman', 8)
c.drawCentredString(mid, y, 'TABLE I')
y -= 12
c.drawCentredString(mid, y, 'FAULTS OF THE TEST DATASET')
y -= 14
c.setLineWidth(0.8)
c.line(L0, y + 8, L1, y + 8)
for r in ['Type   No. of samples   Information of Faults',
          '1      391              K Scatch',
          '2      402              Bumps',
          '3      673              Other Faults',
          '4      1204             Inner Race']:
    c.drawString(L0 + 6, y, r)
    y -= 12
c.line(L0, y + 8, L1, y + 8)
y -= 14
y = body(c, L0, y, 'The dataset contains four classes of faults collected\n'
                   'from a test rig. Each sample is a vibration signal of\n'
                   '2048 points sampled at 12 kHz. The signals are all\n'
                   'normalized before model training begins.')
y -= 16
c.setFont('Times-Roman', 10)
c.drawString(L0, y, 'A. Model Training')
y -= 14
y = body(c, L0, y, 'To make the agent network converge better, each\n'
                   'probability of the pseudo-labels is initialized to\n'
                   '0.5. The inverse class frequency is used when the\n'
                   'class distribution is quite different.')

y = H - 56
c.setFont('Times-Roman', 9)
c.drawCentredString((R0 + R1) / 2, y, 'ALGORITHM 1')
y -= 14
c.setFont('Times-Roman', 8.5)
c.drawString(R0, y, 'Input: labeled set Dl and unlabeled set Du')
y -= 12
for i, step in enumerate(['Pre-train TPG following Eq.1.',
                          'Initialize s0 by new sequence.',
                          'for t = 0 to T do',
                          'Sample the pseudo-label',
                          'end']):
    c.drawString(R0, y, '%d  %s' % (i + 1, step))
    y -= 11
y -= 8
y = body(c, R0, y, 'The reward function in the environment can then\n'
                   'be calculated as follows.')
y -= 16
c.setFont('Times-Italic', 10)
c.drawString(R0 + 40, y, 'rt = R(Yv, Yt)')
c.drawString(R1 - 22, y, '(11)')
y -= 20
y = body(c, R0, y, 'where rt denotes the reward at iteration t and R\n'
                   'denotes the evaluation metric. Then the new state\n'
                   'can be obtained from the environment directly.')
y -= 16
c.setFont('Times-Roman', 10)
c.drawString(R0, y, 'C. Optimization of the MDP')
y -= 14
y = body(c, R0, y, 'After all components are defined, an appropriate\n'
                   'optimization algorithm is required to train the\n'
                   'agent. The reward function is nondifferentiable.')
y -= 18
c.setFont('Times-Italic', 9)
c.drawString(R0 + 68, y + 8, 'exp(dt)')
c.setLineWidth(0.7)
c.line(R0 + 62, y + 3, R0 + 150, y + 3)
c.drawString(R0 + 52, y - 9, 'sum exp(dj)')
c.drawString(R0 + 30, y - 1, 'pi(at|st) =')
c.drawString(R1 - 22, y - 1, '(12)')
y -= 30
y = body(c, R0, y, 'where dt is the score of action t. The softmax\n'
                   'denominator sums over all admissible actions.')

c.showPage()

y = H - 56
c.setFont('Times-Roman', 8)
c.drawCentredString(mid, y, 'TABLE II')
y -= 12
c.drawCentredString(mid, y, 'VECTOR TABLE WITHOUT TEXT LAYER')
y -= 18
for k in range(9):
    c.line(L0, y - k * 16, L1, y - k * 16)
for k in range(5):
    c.line(L0 + k * 62, y, L0 + k * 62, y - 8 * 16)
y = y - 8 * 16 - 26
y = body(c, L0, y, 'methods. Thus, Self-Training-SVM and TPG-SVM can\n'
                   'obtain relatively good results. Consequently, all of\n'
                   'the above analysis indicates that TPG-SVM has a\n'
                   'high ability in dealing with fault classification.')

c.save()
print('written', OUT)
