// SSE framing is independent of HTTP chunks and uses LF, CRLF, or CR line endings.
// This class never parses or logs message contents. Returning false stops at a terminal event.
export class EventStreamDecoder {
  private line = ''
  private skipLF = false
  private data: string[] = []
  private eventName = ''
  private stopped = false
  constructor(private dispatch: (data: string, eventName: string) => boolean) {}
  push(text: string) {
    for (let i = 0; i < text.length && !this.stopped; i++) {
      const c = text[i]
      if (this.skipLF) {
        this.skipLF = false
        if (c === '\n') continue
      }
      if (c === '\r' || c === '\n') {
        this.finishLine()
        this.skipLF = c === '\r'
      } else this.line += c
    }
  }
  private finishLine() {
    const line = this.line
    this.line = ''
    if (!line) {
      this.flush()
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') this.data.push(value)
    if (field === 'event') this.eventName = value
  }
  private flush() {
    const data = this.data.join('\n'),
      eventName = this.eventName
    this.data = []
    this.eventName = ''
    if (data && !this.dispatch(data, eventName)) this.stopped = true
  }
  finish() {
    if (this.stopped) return
    // A complete explicit terminal JSON event at EOF can omit its final blank separator.
    if (this.line) this.finishLine()
    if (!this.stopped) this.flush()
  }
}
