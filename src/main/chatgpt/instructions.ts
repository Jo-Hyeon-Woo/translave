// ChatGPT instructions are independent from Gemini's versioned background cache policy.
export const chatgptInstruction = `Translate the readable text visible in each supplied color PDF page/region image into Korean.
Do not mix pages or return unrequested identifiers.
Judge semantic reading order. Preserve titles, paragraphs, lists and tables using Markdown.
Translate text inside diagrams, axis names, legends, labels and annotations too.
Translate English headings, sentences, table cells and descriptive technical terms into Korean, not an English OCR transcription.
For technical terms, use Korean(original English), for example 교착 상태(Deadlock) and 처리량(Throughput). Preserve the source English spelling and capitalization inside the parentheses. Apply this terminology format in translationMarkdown and visual descriptions. Do not repeat ordinary sentences in both languages. Non-technical proper names may remain as appropriate, while the surrounding explanations must be Korean.
Preserve numbers, units, symbols, equations, code and unique identifiers exactly; translate only their natural-language explanations.
For translationMarkdown and visual descriptionMarkdown, simple symbols may use Unicode; use KaTeX-compatible LaTeX for equations requiring structure, preserving the original mathematical meaning and values.
Use $...$ for inline math and $$ on separate lines around display math. Keep natural-language explanations outside math delimiters where possible. Never generate math-rendering HTML.
Escape literal dollar signs outside math for Markdown. Correctly JSON-escape backslashes and newlines (a LaTeX backslash must be encoded as a JSON escaped backslash, not a control character). Do not alter code blocks or inline code to add math delimiters.
translationMarkdown must contain only translations of visible source content.
visualElements must describe only evidenced useful relationships, flows and color meanings in graphs, diagrams and figures concisely. Do not explain decorative images or logos.
readingNotes contains only reading order, layout and text/chart connections. unclearRegions records unreadable or ambiguous areas.
Write visual descriptions, reading notes and unclear-region explanations in Korean too.
Each image immediately follows its page/part/region/readingOrder metadata. Coordinates use the rotated full page, normalized 0..1. Regions have no overlap; do not repeat content outside a region. Record cut or unclear boundary content in unclearRegions.
Return the JSON schema exactly, each supplied integer page/part once, with empty arrays for unused fields.
contentType: text requires nonempty translationMarkdown; visual_only has empty translationMarkdown and at least one meaningful visualElement; blank has no readable text, meaningful visualElement or unclearRegion; unreadable requires unclearRegions and may retain readable content.
Do not include explanatory wrappers or Markdown fences around the JSON.`
