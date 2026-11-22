// Artificial examples only. Never load a user document/key into these fixtures.
export const basicMath = String.raw`한글 곱셈 $4 \times 128$, 이진수 $1.000_2$, 위첨자 $2^{-1}$, 화살표 $\Rightarrow$. Unicode × → ⇒ 그대로.`
export const richMath = String.raw`## 수식 제목 $x_i^2$

${basicMath}

- 분수 $\frac{a}{b}$, 근호 $\sqrt{x}$, 중첩 $x_{i_j}^{n+1}$
- 합 $\sum_{i=1}^{n} i$ 과 한글 문장

| 항목 | 수식 |
| --- | --- |
| 비율 | $\frac{1}{2}$ |

$$
\begin{bmatrix}1 & 2 \\ 3 & 4\end{bmatrix}
$$

정상 본문 끝입니다.`
export const moneyAndCode = String.raw`금액 $5와 $10, 달러 \$1,200.50, 금액 $20.00.

일반 코드 \`$4 \times 128$\`와 \`2^{-1}\`.

\`\`\`math
$4 \times 128$
\Rightarrow
\`\`\`
`.replaceAll('\\`', '`')
export const unsafeMath = String.raw`정상 앞 $2^{-1}$.

오류 $\frac{1}{$, 미지원 $\notSupported{기밀수식}$.

HTML <script>window.mathUnsafe=true</script><img src="https://evil.invalid/raw">

![image](https://evil.invalid/image) [link](javascript:alert(1))

$\href{javascript:alert(1)}{click}$ $\url{https://evil.invalid/}$ $\includegraphics{https://evil.invalid/tex}$ $\htmlClass{unsafe}{x}$

$\message{수식로그비밀}$ $\errmessage{수식로그비밀}$ $\show\alpha$

$\def\recursive{\recursive}\recursive$

$\gdef\privateMacro{9}\privateMacro$ 그리고 $\privateMacro$.

$\text{한글𝄞}$

정상 뒤 $4 \times 128$.`
export const visualMath = String.raw`도표의 비율 $\frac{1}{2}$ 과 흐름 $A \Rightarrow B$.`
export const longInline =
  '$' + Array.from({ length: 48 }, (_, i) => 'x_{' + i + '}').join(' + ') + '$'
export const longBlock =
  '$$\n' + Array.from({ length: 48 }, (_, i) => 'y_{' + i + '}').join(' + ') + '\n$$'
