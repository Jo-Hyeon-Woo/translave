import { dragPanel } from './readerLayout'
import { test, createTestProfile, closeTestApp, launchTestApp, connectFakeChatGPT } from './helpers'
import { expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { THEME_PALETTE } from '../../src/shared/themes'

let app: ElectronApplication, page: Page, profile: string, errors: number, external: number
const state = () =>
  app.evaluate(
    () =>
      Object.fromEntries(
        Object.entries((globalThis as any).__activeFake).filter(([, v]) => typeof v !== 'function'),
      ) as any,
  )
const set = (value: Record<string, unknown>) =>
  app.evaluate((_e, v) => Object.assign((globalThis as any).__activeFake, v), value)
const advance = () => app.evaluate(() => (globalThis as any).__activeFake.chatAdvance?.())
const finish = () => app.evaluate(() => (globalThis as any).__activeFake.chatFinish?.())
async function launch() {
  ;({ app, page } = await launchTestApp(profile, (page) => {
    page.on('pageerror', () => errors++)
    page.on('request', (r) => {
      if (/^https?:/.test(r.url())) external++
    })
  }))
}
async function pdf(name: string, total = 3) {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica)
  for (let n = 1; n <= total; n++) {
    const p = doc.addPage([400, 400])
    p.drawRectangle({
      x: 0,
      y: 0,
      width: 400,
      height: 400,
      color: name === 'A' ? rgb(1, 0.8, 0.8) : rgb(0.8, 0.9, 1),
    })
    p.drawText('CHAT_FAKE_SOURCE ' + name + ' ' + n, { x: 30, y: 330, size: 17, font })
  }
  await writeFile(join(profile, name + '.pdf'), await doc.save())
}
async function library() {
  if (!(await page.getByRole('dialog', { name: 'files', exact: true }).isVisible()))
    await page.getByRole('button', { name: '파일 목록 열기' }).click()
}
async function add(name = 'A') {
  await library()
  await app.evaluate(
    ({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    },
    join(profile, name + '.pdf'),
  )
  await page.getByRole('button', { name: '파일 또는 폴더 추가', exact: true }).click()
  await page.getByRole('menuitem', { name: '파일', exact: true }).click()
  await expect(page.getByRole('article', { name: name + '.pdf', exact: true })).toBeVisible()
}
async function open(name = 'A') {
  await library()
  await page
    .getByRole('article', { name: name + '.pdf', exact: true })
    .getByRole('button', { name: /열기$/ })
    .click()
  await expect(
    page.locator('.document-tab[data-active="true"] .file-name, .document-add .file-name'),
  ).toHaveText(name + '.pdf')
}
async function chat() {
  await page.getByRole('tab', { name: '채팅', exact: true }).click()
}
async function send(question = '설명해 줘') {
  await page.getByRole('textbox', { name: '질문', exact: true }).fill(question)
  await page.getByRole('button', { name: '전송', exact: true }).click()
}
async function go(n: number) {
  await page.getByRole('textbox', { name: '현재 페이지', exact: true }).fill(String(n))
  await page.getByRole('textbox', { name: '현재 페이지', exact: true }).press('Enter')
}
async function selectQuote(selector: string, start = 0, end?: number) {
  const node = page.locator(selector)
  await expect(node).toBeVisible()
  const positions = await node.evaluate(
    (root, limits) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
        nodes: Text[] = []
      while (walker.nextNode()) nodes.push(walker.currentNode as Text)
      const point = (at: number) => {
        for (const n of nodes) {
          if (at <= n.length) return { n, at }
          at -= n.length
        }
        throw new Error('invalid fixture selection')
      }
      const length = root.textContent!.length,
        a = point(limits.start),
        b = point(limits.end ?? length)
      const rect = (n: Text, offset: number) => {
        const r = document.createRange()
        r.setStart(n, offset)
        r.setEnd(n, offset)
        return r.getBoundingClientRect().toJSON()
      }
      return {
        a: rect(a.n, a.at),
        b: rect(b.n, b.at),
        text: root.textContent!.slice(limits.start, limits.end ?? length),
      }
    },
    { start, end },
  )
  await page.mouse.move(positions.a.x + 0.5, positions.a.y + positions.a.height / 2)
  await page.mouse.down()
  await page.mouse.move(positions.b.x, positions.b.y + positions.b.height / 2, { steps: 12 })
  await page.mouse.up()
  await expect(page.getByRole('button', { name: '채팅에 추가', exact: true })).toBeVisible()
  return positions.text
}
const highlighted = () =>
  page.evaluate(() =>
    [...(CSS.highlights.get('chat-quote-source') ?? [])].map((r) => ({
      text: r.toString(),
      top: (r as Range).getBoundingClientRect().top,
    })),
  )
function stored() {
  const db = new DatabaseSync(join(profile, 'translations/translations.sqlite'))
  try {
    return db
      .prepare(
        'SELECT t.id,t.status,t.question,t.answer,t.attachment_json,c.document_id,c.page FROM chat_turns t JOIN page_chats c ON c.id=t.conversation_id ORDER BY t.rowid',
      )
      .all()
  } finally {
    db.close()
  }
}
test.beforeEach(async () => {
  errors = 0
  external = 0
  profile = await createTestProfile('pagechat')
  await pdf('A')
  await pdf('B', 2)
  await launch()
})

const deleteMenu = () => page.getByRole('menu', { name: '대화 삭제 확인', exact: true })
const turn = (id: string) => page.locator(`.chat-turn[data-turn-id="${id}"]`)

test('question drafts belong to reading tabs, survive sidebar/document switches and clear only on an actual page change or close', async () => {
  await add()
  await add('B')
  await open()
  await chat()
  const input = page.getByRole('textbox', { name: '질문', exact: true })
  const tabs = page.locator('.document-tab')
  await expect(input).toBeFocused()
  await page.keyboard.insertText('first A draft')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('textbox', { name: '메모 본문', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('first A draft')
  await page.keyboard.insertText('kept ')

  await open('B')
  await go(2)
  await chat()
  await expect(input).toBeFocused()
  await page.keyboard.insertText('B page 2 draft')
  await open()
  await expect(input).toBeFocused()
  await page.keyboard.insertText('duplicate A draft')
  await expect(tabs).toHaveCount(3)
  const select = async (index: number, expected: string) => {
    await tabs.nth(index).getByRole('tab').click()
    await expect(input).toBeFocused()
    await expect(input).toHaveValue(expected)
  }
  await select(0, 'kept first A draft')
  await select(1, 'B page 2 draft')
  await page.keyboard.press('Control+Tab')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('duplicate A draft')
  await select(0, 'kept first A draft')
  await go(1)
  await expect(input).toHaveValue('kept first A draft')
  await go(2)
  await expect(input).toHaveValue('')
  await go(1)
  await expect(input).toHaveValue('')
  await chat()
  await page.keyboard.insertText('replacement A draft')
  await select(1, 'B page 2 draft')
  await select(2, 'duplicate A draft')
  await page.keyboard.press('Control+w')
  await expect(tabs).toHaveCount(2)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('B page 2 draft')
  await select(0, 'replacement A draft')
  expect(stored()).toHaveLength(0)
  expect((await state()).chatCalls).toHaveLength(0)
})

async function confirmMenu(id: string) {
  await turn(id).locator('.chat-question').hover()
  await turn(id).getByRole('button', { name: '질문과 답변 삭제', exact: true }).click()
  await expect(deleteMenu()).toBeVisible()
  await expect(deleteMenu()).toContainText('대화를 삭제하시겠습니까?')
}

test('delete confirmation preserves hover geometry and keyboard policy, deletes only the middle pair and persists future context without it', async ({}, info) => {
  await connectFakeChatGPT(page)
  await add()
  await open()
  await chat()
  for (const [index, question] of ['first-kept', 'middle-removed', 'last-kept'].entries()) {
    await send(question)
    await expect(page.locator('.chat-turn')).toHaveCount(index + 1)
    await expect(page.locator('.chat-turn').last()).toHaveAttribute('data-status', 'complete')
  }
  const rows = stored(),
    id = String(rows[1].id)
  await go(2)
  await send('other-page')
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'complete')
  await add('B')
  await open('B')
  await chat()
  await send('other-document')
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'complete')
  const others = stored().filter((row) => !rows.some((r) => r.id === row.id))
  await open('A')
  await go(1)
  await chat()
  const question = turn(id).locator('.chat-question'),
    button = turn(id).getByRole('button', { name: '질문과 답변 삭제', exact: true })
  await question.scrollIntoViewIfNeeded()
  await page.getByRole('textbox', { name: '질문', exact: true }).hover()
  await expect(button).toHaveCSS('opacity', '0')
  const before = await question.boundingBox()
  await question.hover()
  await expect(button).toHaveCSS('opacity', '1')
  expect(await question.boundingBox()).toEqual(before)
  await confirmMenu(id)
  await deleteMenu().hover()
  await expect(deleteMenu()).toBeVisible()
  const tabsBefore = await page.locator('.document-tab').count()
  for (const key of ['Control+f', 'Control+s', 'Control+w']) await page.keyboard.press(key)
  await expect(deleteMenu()).toBeVisible()
  await expect(page.locator('.document-tab')).toHaveCount(tabsBefore)
  await expect(page.getByRole('dialog', { name: 'files', exact: true })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'settings', exact: true })).not.toBeVisible()
  await deleteMenu().getByRole('menuitem', { name: '취소', exact: true }).click()
  await expect(deleteMenu()).toHaveCount(0) // hidden native popovers leave the accessibility tree
  expect(stored().filter((row) => rows.some((r) => r.id === row.id))).toEqual(rows)
  await confirmMenu(id)
  await page.keyboard.press('Escape')
  await expect(deleteMenu()).toHaveCount(0)
  await confirmMenu(id)
  const input = page.getByRole('textbox', { name: '질문', exact: true })
  await input.click()
  await input.fill('keep draft')
  await expect(deleteMenu()).toHaveCount(0)
  expect(stored()).toHaveLength(5)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1000, 680),
  )
  await dragPanel(page)
  for (const theme of THEME_PALETTE) {
    await page.getByRole('button', { name: '설정', exact: true }).click()
    await page.getByRole('button', { name: '테마 선택', exact: true }).click()
    await page.getByRole('button', { name: `${theme.name} 테마`, exact: true }).click()
    await page.getByRole('button', { name: '테마 적용', exact: true }).click()
    await page.getByRole('button', { name: '설정 닫기' }).click()
    await confirmMenu(id)
    const popup = (await deleteMenu().boundingBox())!,
      panel = (await page.locator('.translation-panel').boundingBox())!
    expect(popup.x).toBeGreaterThanOrEqual(panel.x)
    expect(popup.x + popup.width).toBeLessThanOrEqual(panel.x + panel.width)
    const sizing = await deleteMenu().evaluate((node) => {
      const text = node.querySelector('p')!,
        range = document.createRange()
      range.selectNodeContents(text)
      const style = getComputedStyle(node),
        buttons = [...node.querySelectorAll('button')].map((b) => b.getBoundingClientRect())
      return {
        contentFit:
          range.getBoundingClientRect().width +
          parseFloat(style.paddingLeft) +
          parseFloat(style.paddingRight) +
          parseFloat(style.borderLeftWidth) +
          parseFloat(style.borderRightWidth),
        widths: buttons.map((b) => b.width),
        filled: buttons[1].right - buttons[0].left,
        content: text.getBoundingClientRect().width,
      }
    })
    expect(popup.width).toBeCloseTo(sizing.contentFit, 0)
    expect(sizing.widths[0]).toBeCloseTo(sizing.widths[1], 1)
    expect(sizing.filled).toBeCloseTo(sizing.content, 1)
    await page.screenshot({ path: info.outputPath(`${theme.id}-delete-confirm.png`) })
    await page.keyboard.press('Escape')
  }
  await confirmMenu(id)
  await expect(deleteMenu().getByRole('menuitem', { name: '취소', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(deleteMenu().getByRole('menuitem', { name: '삭제', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(deleteMenu()).toHaveCount(0)
  await confirmMenu(id)
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await expect(turn(id)).toHaveCount(0)
  expect(stored().filter((row) => rows.some((r) => r.id === row.id))).toEqual([rows[0], rows[2]])
  expect(stored().filter((row) => others.some((r) => r.id === row.id))).toEqual(others)
  await expect(input).toHaveValue('keep draft')
  await confirmMenu(String(rows[0].id))
  await go(2)
  await expect(deleteMenu()).toHaveCount(0)
  await go(1)
  await confirmMenu(String(rows[0].id))
  await open('B')
  await chat()
  await expect(deleteMenu()).toHaveCount(0)
  await app.close()
  await launch()
  await open('A')
  await go(1)
  await chat()
  await expect(page.locator('.chat-turn')).toHaveCount(2)
  expect((await state()).chatCalls).toHaveLength(0)
  await send('after-deletion')
  await expect(page.locator('.chat-turn')).toHaveCount(3)
  await expect(page.locator('.chat-turn').last()).toHaveAttribute('data-status', 'complete')
  const body = JSON.stringify((await state()).chatCalls[0])
  expect(body).not.toContain('middle-removed')
  expect(body).toContain('first-kept')
  expect(body).toContain('last-kept')
  expect(stored()).toHaveLength(5)
})

test('running deletion is disabled and rechecked, deleting an older pair leaves the active stream intact, and stopped pairs can be removed', async () => {
  await connectFakeChatGPT(page)
  await add()
  await open()
  await chat()
  await send('completed-old')
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'complete')
  const old = String(stored()[0].id)
  await set({ chatMode: 'hold' })
  await send('streaming-current')
  await expect(page.locator('.chat-turn').last()).toHaveAttribute('data-status', 'streaming')
  const active = stored()[1]
  const disabled = turn(String(active.id)).getByRole('button', {
    name: '질문과 답변 삭제',
    exact: true,
  })
  await turn(String(active.id)).locator('.chat-question').hover()
  await expect(disabled).toBeDisabled()
  await expect(disabled).toHaveAttribute('title', /완료된 뒤/)
  const rejection = await page.evaluate(async () => {
    const doc = await window.desktop.readingWorkspace()
    if (doc.status !== 'loaded') throw new Error('missing test workspace')
    const active = doc.workspace.tabs.find((t) => t.id === doc.workspace!.activeId)!
    const history = await window.desktop.pageChat({ documentId: active.documentId, page: 1 })
    if (history.status !== 'ok') throw new Error('missing test history')
    return window.desktop.deletePageChatTurn(history.snapshot.active!)
  })
  expect(rejection.status).toBe('error')
  const requests = (await state()).chatCalls.length
  await confirmMenu(old)
  await deleteMenu().getByRole('menuitem', { name: '삭제', exact: true }).click()
  await expect(turn(old)).toHaveCount(0)
  await expect(turn(String(active.id))).toHaveAttribute('data-status', 'streaming')
  expect((await state()).chatCalls).toHaveLength(requests)
  await advance()
  await expect(page.getByTestId('chat-answer')).toContainText('기술 용어')
  await page.getByRole('button', { name: '응답 중지', exact: true }).click()
  await expect(turn(String(active.id))).toHaveAttribute('data-status', 'stopped')
  await finish()
  await confirmMenu(String(active.id))
  await deleteMenu().getByRole('menuitem', { name: '삭제', exact: true }).click()
  await expect(page.locator('.chat-turn')).toHaveCount(0)
  expect(stored()).toHaveLength(0)
  expect((await state()).chatCalls).toHaveLength(requests)
})

test('SQLite deletion failure retains the pair and its saved attachment, shows a safe error and allows explicit retry', async ({}, info) => {
  await connectFakeChatGPT(page)
  await add()
  await open()
  await chat()
  await send('preserve-on-failure')
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'complete')
  const before = stored(),
    id = String(before[0].id)
  const db = new DatabaseSync(join(profile, 'translations/translations.sqlite'))
  try {
    db.exec(
      "CREATE TRIGGER block_chat_delete BEFORE DELETE ON chat_turns BEGIN SELECT RAISE(FAIL,'PRIVATE_DELETE_DIAGNOSTIC'); END",
    )
    await confirmMenu(id)
    await deleteMenu().getByRole('menuitem', { name: '삭제', exact: true }).click()
    await expect(deleteMenu().getByRole('alert')).toHaveText(
      '대화를 삭제하지 못했어요. 로컬 저장소를 확인해 주세요.',
    )
    expect(stored()).toEqual(before)
    await expect(turn(id)).toBeVisible()
    expect((await state()).chatCalls).toHaveLength(1)
    await page.screenshot({ path: info.outputPath('delete-storage-failure.png') })
    db.exec('DROP TRIGGER block_chat_delete')
    await deleteMenu().getByRole('menuitem', { name: '삭제', exact: true }).click()
    await expect(turn(id)).toHaveCount(0)
    expect(stored()).toHaveLength(0)
  } finally {
    db.close()
  }
})

test('selected PDF quotations keep exact ranges, scroll-aware fades and removal through zoom and resizing without changing the question', async ({}, info) => {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica)
  const p = doc.addPage([400, 400])
  for (const y of [330, 250]) p.drawText('REPEATED SELECTED SENTENCE', { x: 25, y, size: 13, font })
  await writeFile(join(profile, 'A.pdf'), await doc.save())
  await connectFakeChatGPT(page)
  await add()
  await open()
  await chat()
  await page.getByRole('textbox', { name: '질문', exact: true }).fill('유지할 질문')
  await page.getByRole('textbox', { name: '질문', exact: true }).press('Meta+A')
  await expect(page.getByRole('button', { name: '채팅에 추가', exact: true })).toHaveCount(0)
  await expect(page.locator('.textLayer > span')).toHaveCount(2)
  const selected = await selectQuote('.textLayer > span:nth-of-type(2)')
  const popup = await page.getByRole('button', { name: '채팅에 추가', exact: true }).boundingBox()
  expect(popup!.x).toBeGreaterThanOrEqual(0)
  await page.screenshot({ path: info.outputPath('selection-button.png') })
  await page.getByRole('button', { name: '채팅에 추가', exact: true }).click()
  await expect(page.locator('.chat-quote-chip')).toHaveCount(1)
  const list = page.locator('.chat-quote-list'),
    viewport = page.locator('.chat-quote-viewport')
  const edgeMeasurements: unknown[] = []
  const edges = async (label: string, left: boolean, right: boolean) => {
    await expect(viewport).toHaveAttribute('data-overflow-left', String(left))
    await expect(viewport).toHaveAttribute('data-overflow-right', String(right))
    await expect
      .poll(() =>
        viewport.evaluate((node) =>
          ['::before', '::after'].map((pseudo) => Number(getComputedStyle(node, pseudo).opacity)),
        ),
      )
      .toEqual([Number(left), Number(right)])
    const bounds = await viewport.evaluate((node) => {
      const list = node.querySelector('.chat-quote-list')!,
        box = list.getBoundingClientRect(),
        shell = node.closest('.chat-input-shell')!,
        send = shell.querySelector('.chat-submit')!.getBoundingClientRect()
      return {
        left: list.scrollLeft,
        remaining: list.scrollWidth - list.clientWidth - list.scrollLeft,
        width: box.width,
        listInset: box.left - shell.getBoundingClientRect().left,
        gap: list.children[1]
          ? list.children[1].getBoundingClientRect().left -
            list.children[0].getBoundingClientRect().right
          : null,
        overlapsSend: box.right > send.left,
        pointer: ['::before', '::after'].map((p) => getComputedStyle(node, p).pointerEvents),
        fadeBackgrounds: ['::before', '::after'].map(
          (p) => getComputedStyle(node, p).backgroundImage,
        ),
        background: getComputedStyle(shell).backgroundColor,
      }
    })
    expect(bounds.overlapsSend).toBe(false)
    expect(bounds.listInset).toBe(9)
    expect(bounds.pointer).toEqual(['none', 'none'])
    if (bounds.gap !== null) expect(bounds.gap).toBe(6)
    for (const fade of bounds.fadeBackgrounds) expect(fade).toContain(bounds.background)
    edgeMeasurements.push({ label, fades: { left, right }, ...bounds })
    return bounds
  }
  await edges('one-quote-fits', false, false)
  await expect(page.getByRole('textbox', { name: '질문', exact: true })).toHaveValue('유지할 질문')
  expect((await state()).chatCalls).toHaveLength(0)
  await page.locator('.chat-quote-chip').hover()
  await expect.poll(async () => (await highlighted()).map((r) => r.text)).toEqual([selected])
  const originalY = await page.locator('.textLayer > span:nth-of-type(2)').evaluate((n) => {
    const r = document.createRange()
    r.selectNodeContents(n)
    return r.getBoundingClientRect().top
  })
  expect((await highlighted())[0].top).toBeCloseTo(originalY, 0)
  await page.getByRole('button', { name: '확대', exact: true }).click()
  await expect(page.getByTestId('page-stage')).toHaveAttribute('data-status', 'ready')
  await dragPanel(page, 45)
  await page.locator('.chat-quote-chip').hover()
  await expect.poll(async () => (await highlighted()).map((r) => r.text)).toEqual([selected])
  const zoomY = await page.locator('.textLayer > span:nth-of-type(2)').evaluate((n) => {
    const r = document.createRange()
    r.selectNodeContents(n)
    return r.getBoundingClientRect().top
  })
  expect((await highlighted())[0].top).toBeCloseTo(zoomY, 0)
  await page.mouse.move(10, 10)
  await expect.poll(highlighted).toEqual([])
  await selectQuote('.textLayer > span:nth-of-type(1)')
  await page.getByRole('button', { name: '채팅에 추가', exact: true }).click()
  await expect(page.locator('.chat-quote-chip')).toHaveCount(2)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
  await dragPanel(page, 27)
  const shell = page.locator('.chat-input-shell')
  await expect(shell).toHaveAttribute('data-multiline', 'true')
  const boxes = await page.locator('.chat-quote-list').boundingBox(),
    sendBox = await page.getByRole('button', { name: '전송', exact: true }).boundingBox()
  expect(boxes!.x + boxes!.width).toBeLessThan(sendBox!.x)
  const strip = await page.locator('.chat-quote-list').evaluate((n) => ({
    width: n.clientWidth,
    content: n.scrollWidth,
    tops: [...n.children].map((c) => c.getBoundingClientRect().top),
  }))
  expect(strip.content).toBeGreaterThan(strip.width)
  expect(new Set(strip.tops).size).toBe(1)
  const start = await edges('narrow-left', false, true)
  await list.hover()
  await page.mouse.wheel((strip.content - strip.width) / 2, 0)
  const middle = await edges('narrow-middle', true, true)
  expect(middle.left).toBeGreaterThan(1)
  expect(middle.remaining).toBeGreaterThan(1)
  expect(middle.width).toBe(start.width)
  await page.screenshot({ path: info.outputPath('quote-fades-middle.png') })
  await page.mouse.wheel(strip.content, 0)
  await edges('narrow-right', true, false)
  await page.screenshot({ path: info.outputPath('quote-fades-right.png') })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 900))
  await dragPanel(page, 45)
  await edges('wide-fits-after-resize', false, false)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
  await dragPanel(page, 27)
  await edges('narrow-after-resize', false, true)
  await page.locator('.chat-quote-chip').first().hover()
  await expect.poll(async () => (await highlighted()).map((r) => r.text)).toEqual([selected])
  await page.getByRole('button', { name: '선택 문장 1 해제', exact: true }).click()
  await expect(page.locator('.chat-quote-chip')).toHaveCount(1)
  await edges('fits-after-removal', false, false)
  await selectQuote('.textLayer > span:nth-of-type(2)')
  await page.getByRole('button', { name: '채팅에 추가', exact: true }).click()
  await expect(page.locator('.chat-quote-chip')).toHaveCount(2)
  await edges('overflow-after-addition', false, true)
  await page
    .getByRole('textbox', { name: '질문', exact: true })
    .fill('여러 줄 질문\n질문은 유지합니다\n첨부는 아래에 있습니다')
  await page.screenshot({ path: info.outputPath('quote-capsules-narrow.png') })
  await page.getByRole('textbox', { name: '질문', exact: true }).fill('유지할 질문')
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let n = 0; n < 4; n++) {
      await page.keyboard.press(key)
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY')
    }
  }
  await page.getByRole('textbox', { name: '질문', exact: true }).click()
  await page.getByRole('textbox', { name: '질문', exact: true }).press('Alt+F10')
  await expect(page.getByRole('button', { name: '선택 문장 1 해제' })).toBeFocused()
  await page.keyboard.press('End')
  await page.keyboard.press('Delete')
  await expect(page.locator('.chat-quote-chip')).toHaveCount(1)
  await page.keyboard.press('Delete')
  await expect(page.locator('.chat-quote-list')).toHaveCount(0)
  await expect(shell).toHaveAttribute('data-multiline', 'false')
  await expect(page.getByRole('textbox', { name: '질문', exact: true })).toBeFocused()
  await writeFile(info.outputPath('quote-edges.json'), JSON.stringify(edgeMeasurements, null, 2))
  await page.screenshot({ path: info.outputPath('pdf-quotes.png') })
})

test('selected dialogue text and PDF quotes send full references with the image, survive restart and history, and render as plain text', async ({}, info) => {
  await connectFakeChatGPT(page)
  await add()
  await open()
  await chat()
  const unsafe = '선택 인용 <img src="https://invalid.test/quote.png"> 와 <script>unsafe()</script>'
  await send(unsafe)
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'complete')
  await page.getByRole('textbox', { name: '질문', exact: true }).fill('인용을 설명해 줘')
  await selectQuote('[data-quote-role="user"]')
  await page.getByRole('button', { name: '채팅에 추가', exact: true }).click()
  await page.locator('.chat-quote-chip').hover()
  await expect.poll(async () => (await highlighted()).map((r) => r.text)).toEqual([unsafe])
  const assistant = await selectQuote('[data-quote-role="assistant"] > p:first-of-type')
  await page.getByRole('button', { name: '채팅에 추가', exact: true }).click()
  await dragPanel(page, 28)
  await page.locator('.chat-quote-chip').nth(1).hover()
  await expect.poll(async () => (await highlighted()).map((r) => r.text)).toEqual([assistant])
  await selectQuote('.textLayer > span')
  await page.getByRole('button', { name: '채팅에 추가', exact: true }).click()
  await expect(page.locator('.chat-quote-chip')).toHaveCount(3)
  await page.getByRole('button', { name: '전송', exact: true }).click()
  await expect(page.locator('.chat-turn')).toHaveCount(2)
  await expect(page.locator('.chat-turn').last()).toHaveAttribute('data-status', 'complete')
  await expect(page.locator('.chat-quote-chip')).toHaveCount(0)
  const sent = (await state()).chatCalls.at(-1).input.at(-1).content
  expect(sent.filter((c: any) => c.type === 'input_image')).toHaveLength(1)
  const refs = sent.filter((c: any) => c.type === 'input_text').map((c: any) => c.text)
  const quotations = JSON.parse(refs[1]).quotations
  expect(quotations[0].text).toBe(unsafe)
  expect(quotations[0].source.ranges[0]).toMatchObject({ turnId: stored()[0].id, role: 'user' })
  expect(quotations[1].source.ranges[0]).toMatchObject({
    turnId: stored()[0].id,
    role: 'assistant',
  })
  expect(quotations[2].source).toMatchObject({ kind: 'pdf', page: 1 })
  expect(refs.at(-1)).toBe('인용을 설명해 줘')
  expect(JSON.parse(stored()[1].attachment_json as string).quotes).toEqual(quotations)
  await page.locator('.chat-sent-quotes summary').click()
  await expect(page.locator('.chat-sent-quotes blockquote').first()).toContainText(unsafe)
  await expect(page.locator('.chat-sent-quotes img,.chat-sent-quotes script')).toHaveCount(0)
  await app.close()
  await launch()
  await open()
  await chat()
  expect((await state()).chatCalls).toHaveLength(0)
  await page.locator('.chat-sent-quotes summary').click()
  await expect(page.locator('.chat-sent-quotes blockquote').first()).toContainText(unsafe)
  await send('재시작 후 질문')
  await expect(page.locator('.chat-turn')).toHaveCount(3)
  await expect(page.locator('.chat-turn').last()).toHaveAttribute('data-status', 'complete')
  expect((await state()).chatCalls[0].input[2].content[0].text).toContain('selected_quotations')
  await page.screenshot({ path: info.outputPath('saved-quotation.png') })
})

test('quotation drafts are discarded on page or document change while in-flight excerpts keep their original owner', async () => {
  await connectFakeChatGPT(page)
  await add()
  await add('B')
  await open()
  await page.getByRole('tab', { name: '번역', exact: true }).click()
  await selectQuote('.textLayer > span')
  await page.getByRole('button', { name: '채팅에 추가', exact: true }).click()
  await expect(page.getByRole('tab', { name: '채팅', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.locator('.chat-quote-chip')).toHaveCount(1)
  await go(2)
  await go(1)
  await expect(page.locator('.chat-quote-chip')).toHaveCount(0)
  await selectQuote('.textLayer > span')
  await page.getByRole('button', { name: '채팅에 추가', exact: true }).click()
  await open('B')
  await open('A')
  await chat()
  await expect(page.locator('.chat-quote-chip')).toHaveCount(0)
  await selectQuote('.textLayer > span')
  await page.getByRole('button', { name: '채팅에 추가', exact: true }).click()
  await set({ chatMode: 'hold' })
  await send('고정된 인용 질문')
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'streaming')
  await go(2)
  await expect(page.locator('.chat-turn')).toHaveCount(0)
  await finish()
  await go(1)
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'complete')
  expect(JSON.parse(stored()[0].attachment_json as string).quotes[0].source.page).toBe(1)
  await expect(page.locator('.chat-quote-chip')).toHaveCount(0)
})
test.afterEach(async () => {
  const s = await state()
  await closeTestApp(app, profile)
  expect(s.gemini).toBe(0)
  expect(s.unknown).toBe(0)
  expect(s.maxActive).toBeLessThanOrEqual(1)
  expect(s.logSites).toEqual([])
  expect(errors).toBe(0)
  expect(external).toBe(0)
})

test('chat tab has no implicit inference, connection settings reuse, click tabs, and frozen page histories survive switching/restart', async ({}, info) => {
  await chat()
  await expect(page.getByRole('tab')).toHaveCount(3)
  await expect(page.getByRole('tab', { name: '추출 텍스트' })).toHaveCount(0)
  await expect(page.locator('.chat-heading')).toHaveCount(0)
  await expect(page.locator('.language-bar')).toContainText('페이지별 대화')
  const status = await page.locator('.connection-badge').boundingBox()
  await page.getByLabel('채팅 메뉴', { exact: true }).click()
  await expect(page.locator('.translation-menu-content button')).toHaveCount(2)
  await expect(page.getByRole('button', { name: '현재 페이지 대화 초기화' })).toBeDisabled()
  await page.getByRole('tab', { name: '번역', exact: true }).click()
  await expect(page.locator('.translation-menu')).not.toHaveAttribute('open', '')
  await expect(page.locator('.language-bar')).toContainText('영어한국어')
  expect(await page.locator('.connection-badge').boundingBox()).toEqual(status)
  await page.getByLabel('번역 메뉴', { exact: true }).click()
  await expect(page.getByRole('button', { name: '다시 번역', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '현재 페이지 대화 초기화' })).toHaveCount(0)
  await page.getByRole('tab', { name: '채팅', exact: true }).click()
  await expect(page.getByText('PDF를 열면 페이지별로 질문할 수 있어요.')).toBeVisible()
  expect((await state()).chatCalls).toHaveLength(0)
  await page.getByRole('button', { name: 'ChatGPT 설정 열기' }).click()
  await expect(page.getByRole('button', { name: 'ChatGPT로 로그인' })).toBeVisible()
  await page.getByRole('button', { name: '설정 닫기' }).click()
  await connectFakeChatGPT(page)
  await add()
  await open()
  await chat()
  await page.getByRole('tab', { name: '번역', exact: true }).click()
  await expect(page.getByRole('tab', { name: '번역', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await page.getByRole('tab', { name: '채팅', exact: true }).click()
  await expect(page.getByRole('tab', { name: '채팅', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await page.getByRole('textbox', { name: '질문', exact: true }).fill('첫 페이지 질문')
  await expect(page.getByRole('button', { name: '전송', exact: true })).toBeEnabled()
  await page.getByRole('textbox', { name: '질문', exact: true }).press('Meta+Enter')
  await expect(page.locator('.chat-turn')).toHaveCount(1)
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'complete')
  await expect(page.locator('.chat-answer .katex-mathml')).toHaveCount(1)
  expect(await page.evaluate(() => (window as any).__chatUnsafe)).toBeUndefined()
  await expect(page.locator('.chat-answer img,.chat-answer a')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('chat-normal.png') })
  await go(2)
  await expect(page.locator('.language-bar')).toContainText('2페이지 대화')
  await expect(page.locator('.chat-turn')).toHaveCount(0)
  await send('둘째 페이지 질문')
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'complete')
  await go(1)
  await expect(page.locator('.chat-question')).toContainText('첫 페이지 질문')
  await add('B')
  await open('B')
  await chat()
  await expect(page.locator('.chat-turn')).toHaveCount(0)
  await send('다른 문서 질문')
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'complete')
  await open()
  await chat()
  await expect(page.locator('.chat-question')).toContainText('첫 페이지 질문')
  await app.close()
  await launch()
  await open()
  await chat()
  await expect(page.locator('.chat-question')).toContainText('첫 페이지 질문')
  await send('다시 시작한 후속 질문')
  await expect(page.locator('.chat-turn')).toHaveCount(2)
  await expect(page.locator('.chat-turn').last()).toHaveAttribute('data-status', 'complete')
  const s = await state()
  expect(s.chatCalls).toHaveLength(1)
  expect(s.chatCalls[0].input.slice(0, 2).map((m: any) => m.role)).toEqual(['user', 'assistant'])
  expect(stored()).toHaveLength(4)
})

test('every message includes only the current color page plus completed local history, independent of viewer zoom and panel width', async () => {
  await connectFakeChatGPT(page)
  await add()
  await open()
  await expect(page.getByTestId('live-translation')).toBeVisible()
  await chat()
  await expect(page.getByRole('button', { name: /^채팅 첨부:/ })).toHaveCount(0)
  await expect(page.getByRole('menuitemradio')).toHaveCount(0)
  await send('첫 질문')
  await expect(page.locator('.chat-turn').last()).toHaveAttribute('data-status', 'complete')
  await page.getByRole('button', { name: '확대', exact: true }).click()
  await dragPanel(page)
  await send('후속 질문')
  await expect(page.locator('.chat-turn')).toHaveCount(2)
  await expect(page.locator('.chat-turn').last()).toHaveAttribute('data-status', 'complete')
  const calls = (await state()).chatCalls
  expect(calls.map((c: any) => c.input.length)).toEqual([1, 3])
  const pictures: string[] = []
  for (const call of calls) {
    const parts = call.input.at(-1).content
    expect(JSON.parse(parts[0].text)).toMatchObject({
      documentName: 'A.pdf',
      page: 1,
      part: 1,
      attachment: 'page_image',
    })
    expect(parts.filter((c: any) => c.type === 'input_image')).toHaveLength(1)
    expect(parts[1].detail).toBe('high')
    expect(parts[1].image_url.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(JSON.stringify(call).includes('translatedContent')).toBe(false)
    expect(JSON.stringify(call).includes('CHAT_FAKE_SOURCE')).toBe(false)
    expect(parts.some((c: any) => c.type === 'input_file')).toBe(false)
    pictures.push(parts[1].image_url)
  }
  expect(pictures[0] === pictures[1]).toBe(true)
  const pixels = await page.evaluate(async (url) => {
    const image = new Image()
    image.src = url
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(image, 0, 0)
    return {
      width: image.width,
      height: image.height,
      rgb: [...ctx.getImageData(5, 5, 1, 1).data].slice(0, 3),
    }
  }, pictures[0])
  expect(pixels.width).toBe(800)
  expect(pixels.height).toBe(800)
  expect(pixels.rgb[0]).toBeGreaterThan(pixels.rgb[1] + 30)
  expect(pixels.rgb[1]).toBeGreaterThan(150)
  expect(stored().every((row: any) => JSON.parse(row.attachment_json).kind === 'page_image')).toBe(
    true,
  )
  expect(JSON.stringify(stored()).includes('base64')).toBe(false)
})

test('streams before completion, remains on its original document/page, and allows stop and clear without late reconstruction', async ({}, info) => {
  await connectFakeChatGPT(page)
  await add()
  await open()
  await chat()
  await set({ chatMode: 'hold' })
  await send('고정된 페이지 질문')
  await expect(page.getByTestId('chat-answer')).toContainText('첫 번째 조각')
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'streaming')
  expect(stored()[0].status).toBe('streaming')
  await go(2)
  await expect(page.locator('.chat-turn')).toHaveCount(0)
  await advance()
  await go(1)
  await expect(page.getByTestId('chat-answer')).toContainText('기술 용어')
  await expect(page.locator('.chat-answer .katex-mathml')).toHaveCount(1)
  await page.screenshot({ path: info.outputPath('chat-streaming.png') })
  await add('B')
  await open('B')
  await chat()
  await expect(page.locator('.chat-turn')).toHaveCount(0)
  await open('A')
  await chat()
  await expect(page.getByTestId('chat-answer')).toContainText('기술 용어')
  expect((await state()).chatCalls[0].input).toHaveLength(1)
  expect(JSON.stringify((await state()).chatCalls[0])).not.toContain('file_data')
  await page.getByRole('button', { name: '응답 중지' }).click()
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'stopped')
  await finish()
  await page.waitForTimeout(80)
  expect(stored()[0].status).toBe('stopped')
  await set({ chatMode: 'hold' })
  await send('지울 질문')
  await expect(page.locator('.chat-turn')).toHaveCount(2)
  await page.getByLabel('채팅 메뉴', { exact: true }).click()
  await page.getByRole('button', { name: '현재 페이지 대화 초기화' }).click()
  await expect(page.locator('.chat-turn')).toHaveCount(2)
  await page
    .getByRole('menu', { name: '대화 초기화 확인', exact: true })
    .getByRole('menuitem', { name: '초기화', exact: true })
    .click()
  await expect(page.locator('.chat-turn')).toHaveCount(0)
  await finish()
  await page.waitForTimeout(80)
  expect(stored()).toHaveLength(0)
  await set({ chatMode: 'normal' })
  await send('새 대화')
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'complete')
  expect((await state()).chatCalls.at(-1).input).toHaveLength(1)
})

test('an untranslated page can queue image chat, while a changed original fails without sending a text fallback', async () => {
  await connectFakeChatGPT(page)
  await set({ holdDoc: 'A', holdPage: 1 })
  await add()
  await open()
  await expect
    .poll(() => app.evaluate(() => typeof (globalThis as any).__activeFake.release === 'function'))
    .toBe(true)
  await chat()
  await send()
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'queued')
  expect((await state()).chatCalls).toHaveLength(0)
  await app.evaluate(() => (globalThis as any).__activeFake.release?.())
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'complete')
  expect((await state()).chatCalls).toHaveLength(1)
  await writeFile(join(profile, 'A.pdf'), '%PDF-CHANGED')
  await send()
  await expect(page.getByRole('alert')).toContainText('페이지 이미지를 만들지 못했어요')
  expect((await state()).chatCalls).toHaveLength(1)
  await expect(page.locator('.chat-turn')).toHaveCount(1)
})

test('chat waits for the running translation, overtakes the next batch, then resumes original queue; waiting chat can be stopped', async () => {
  await pdf('A', 8)
  await connectFakeChatGPT(page)
  await set({ holdDoc: 'A', holdPage: 1, chatMode: 'hold' })
  await add()
  await open()
  await chat()
  await expect.poll(async () => (await state()).calls.length).toBe(1)
  await send('우선 채팅')
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'queued')
  expect((await state()).chatCalls).toHaveLength(0)
  await page.getByRole('button', { name: '응답 중지' }).click()
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'stopped')
  await page.getByRole('button', { name: '다시 시도', exact: true }).click()
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'queued')
  await app.evaluate(() => (globalThis as any).__activeFake.release?.())
  await expect(page.getByTestId('chat-answer')).toContainText('첫 번째 조각')
  expect((await state()).timeline).toEqual(['translation:A:1,2,3,4,5', 'chat'])
  await finish()
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'complete')
  await expect.poll(async () => (await state()).calls.length).toBe(2)
  expect((await state()).timeline).toEqual([
    'translation:A:1,2,3,4,5',
    'chat',
    'translation:A:6,7,8',
  ])
  expect(stored()).toHaveLength(1)
})

test('failed streams retain partial status, retry updates one turn, restart marks interrupted answers stopped', async () => {
  await connectFakeChatGPT(page)
  await add()
  await open()
  await chat()
  await set({ chatMode: 'missing' })
  await send('실패 질문')
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'error')
  expect(stored()[0].status).toBe('error')
  const id = stored()[0].id
  await set({ chatMode: 'normal' })
  await page.getByRole('button', { name: '다시 시도', exact: true }).click()
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'complete')
  expect(stored()[0].id).toBe(id)
  expect(stored()).toHaveLength(1)
  await set({ chatMode: 'hold' })
  await send('앱 종료 중 응답')
  await expect(page.locator('.chat-turn').last()).toHaveAttribute('data-status', 'streaming')
  await app.close()
  await launch()
  await open()
  await chat()
  await expect(page.locator('.chat-turn').last()).toHaveAttribute('data-status', 'stopped')
  expect((await state()).chatCalls).toHaveLength(0)
})

test('narrow sidebar keeps streamed Markdown stable and preserves prior-reading scroll, with explicit new-output navigation', async ({}, info) => {
  await connectFakeChatGPT(page)
  await add()
  await open()
  await chat()
  await set({
    chatMode: 'hold',
    chatText: '문단 설명과 수식 $x^2$\n\n'.repeat(160) + '\n```js\nconst x = 1',
  })
  await send('긴 답변 질문')
  for (let n = 0; n < 5; n++) {
    await advance()
    await page.waitForTimeout(60)
  }
  const messages = page.getByRole('log', { name: '페이지 대화' })
  await expect
    .poll(async () => messages.evaluate((n) => n.scrollHeight > n.clientHeight))
    .toBe(true)
  await expect
    .poll(async () => messages.evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight < 50))
    .toBe(true)
  await messages.evaluate((n) => {
    n.scrollTop = 0
    n.dispatchEvent(new Event('scroll'))
  })
  await advance()
  await page.waitForTimeout(100)
  expect(await messages.evaluate((n) => n.scrollTop)).toBeLessThan(2)
  await expect(page.getByRole('button', { name: '새 답변으로 이동' })).toBeVisible()
  await page.getByRole('button', { name: '새 답변으로 이동' }).click()
  await expect
    .poll(async () => messages.evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight < 50))
    .toBe(true)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1000, 680),
  )
  await dragPanel(page)
  await page.screenshot({ path: info.outputPath('chat-narrow-stream.png') })
  const bounds = await page.locator('.chat-composer').boundingBox(),
    card = await page.locator('.translation-panel').boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(card!.x)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(card!.x + card!.width + 1)
  await finish()
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'complete')
  await page.locator('.chat-answer pre').scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('chat-narrow-complete.png') })
})

test('capsule composer grows, scrolls, shrinks and reflows without overlapping its controls; IME and shortcuts remain intact', async ({}, info) => {
  await connectFakeChatGPT(page)
  await add()
  await open()
  await chat()
  const shell = page.locator('.chat-input-shell'),
    input = page.getByRole('textbox', { name: '질문', exact: true })
  const geometry = () =>
    shell.evaluate((node) => {
      const box = (selector: string) => node.querySelector(selector)!.getBoundingClientRect()
      const input = box('textarea'),
        send = box('.chat-submit')
      const area = node.getBoundingClientRect(),
        style = getComputedStyle(node)
      const field = node.querySelector('textarea')!
      return {
        height: area.height,
        radius: parseFloat(style.borderRadius),
        inputHeight: input.height,
        inputTop: input.top,
        inputBottom: input.bottom,
        sendTop: send.top,
        textCenter: input.top + input.height / 2,
        sendCenter: send.top + send.height / 2,
        leftInset: input.left - area.left,
        textInset: input.left - area.left + parseFloat(getComputedStyle(field).paddingLeft),
        rightInset: area.right - send.right,
        rightGap: send.left - input.right,
        scroll: field.scrollHeight - field.clientHeight,
        inside: send.right <= area.right && input.left >= area.left,
      }
    })
  await expect(shell).toHaveAttribute('data-multiline', 'false')
  const initial = await geometry()
  expect(initial.height).toBeLessThan(55)
  expect(initial.radius).toBeGreaterThanOrEqual(initial.height / 2)
  expect(Math.abs(initial.textCenter - initial.sendCenter)).toBeLessThan(1)
  expect(initial.textInset).toBe(17)
  await expect(shell.locator('.chat-attachment-control')).toHaveCount(0)
  expect(initial.rightGap).toBeGreaterThan(0)
  await page.screenshot({ path: info.outputPath('composer-single.png') })
  await input.fill('abcde '.repeat(17))
  await expect(shell).toHaveAttribute('data-multiline', 'true')
  const expanded = await geometry()
  expect(expanded.height).toBeGreaterThan(initial.height)
  expect(expanded.inputBottom).toBeLessThanOrEqual(expanded.sendTop - 7)
  expect(expanded.rightInset).toBe(initial.rightInset)
  expect(expanded.textInset).toBe(initial.textInset)
  expect(expanded.leftInset).toBe(initial.leftInset)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1000, 680),
  )
  await expect
    .poll(async () => (await geometry()).inputHeight)
    .toBeGreaterThanOrEqual(expanded.inputHeight)
  await dragPanel(page)
  await input.fill('긴 질문과 한글 줄바꿈\n'.repeat(50))
  await expect.poll(async () => (await geometry()).scroll).toBeGreaterThan(0)
  expect((await geometry()).inputHeight).toBeLessThanOrEqual(144)
  expect((await geometry()).textInset).toBe(initial.textInset)
  expect((await geometry()).inside).toBe(true)
  expect(await page.locator('.chat-messages').evaluate((n) => n.clientHeight)).toBeGreaterThan(60)
  await page.screenshot({ path: info.outputPath('composer-max-narrow.png') })
  await input.fill('')
  await expect(shell).toHaveAttribute('data-multiline', 'false')
  expect((await geometry()).height).toBe(initial.height)
  await input.fill('한글 입력')
  await input.dispatchEvent('keydown', { key: 'Enter', metaKey: true, isComposing: true })
  expect((await state()).chatCalls).toHaveLength(0)
  await input.press('Shift+Enter')
  await expect(input).toHaveValue('한글 입력\n')
  await input.press('Enter')
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'complete')
  await expect(input).toHaveValue('')
  await expect(shell).toHaveAttribute('data-multiline', 'false')
})

test('Enter uses the send-button path while Shift+Enter inserts at the cursor and existing input limits remain enforced', async () => {
  await chat()
  const input = page.getByRole('textbox', { name: '질문', exact: true })
  await expect(input).toBeDisabled()
  await expect(page.getByRole('button', { name: '전송', exact: true })).toBeDisabled()
  await add()
  await open()
  await chat()
  await input.fill('연결 없는 질문')
  await input.press('Enter')
  expect((await state()).chatCalls).toHaveLength(0)
  await expect(page.locator('.page-chat [role="alert"]')).toHaveCount(0)
  await connectFakeChatGPT(page)
  await input.fill('   ')
  await input.press('Enter')
  await expect(input).toHaveValue('   ')
  expect((await state()).chatCalls).toHaveLength(0)
  await input.fill('abcdef')
  await expect(page.getByRole('button', { name: '전송', exact: true })).toBeEnabled()
  await input.evaluate((n) => (n as HTMLTextAreaElement).setSelectionRange(3, 3))
  await input.press('Shift+Enter')
  await expect(input).toHaveValue('abc\ndef')
  expect((await state()).chatCalls).toHaveLength(0)
  await input.press('Enter')
  await expect(page.locator('.chat-turn')).toHaveCount(1)
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'complete')
  expect(stored()[0].question).toBe('abc\ndef')
  await expect(input).toHaveValue('')
  await send('버튼으로 전송')
  await expect(page.locator('.chat-turn')).toHaveCount(2)
  await expect(page.locator('.chat-turn').last()).toHaveAttribute('data-status', 'complete')
  expect(stored()[1].question).toBe('버튼으로 전송')
  await input.fill('x'.repeat(8001))
  await input.press('Enter')
  await expect(page.getByRole('button', { name: '전송', exact: true })).toBeDisabled()
  expect((await state()).chatCalls).toHaveLength(2)
  await expect(page.locator('.page-chat [role="alert"]')).toContainText('8,000자 이하')
  expect((await input.inputValue()).length).toBe(8001)
})

test('IME confirmation never sends, repeated or duplicate Enter cannot submit during preparation or streaming', async () => {
  await connectFakeChatGPT(page)
  await add()
  await open()
  await chat()
  const input = page.getByRole('textbox', { name: '질문', exact: true })
  await input.fill('한글 조합 질문')
  await expect(page.getByRole('button', { name: '전송', exact: true })).toBeEnabled()
  await input.evaluate((n) => {
    const down = (init: KeyboardEventInit = {}) =>
      n.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }),
      )
    const up = () => n.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
    const start = () => n.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    const end = () =>
      n.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '한글' }))
    start()
    down({ isComposing: true })
    end()
    up()
    start()
    down({ isComposing: false })
    end()
    up()
    start()
    end()
    down()
    up()
    down({ isComposing: true })
    up()
    down({ keyCode: 229 })
    up()
    down({ repeat: true })
    up()
  })
  expect((await state()).chatCalls).toHaveLength(0)
  await expect(page.locator('.chat-turn')).toHaveCount(0)
  await expect(input).toHaveValue('한글 조합 질문')
  await set({ chatMode: 'hold' })
  await app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents,
      send = wc.send.bind(wc)
    let held = false
    wc.send = (channel: string, ...args: any[]) => {
      if (!held && channel === 'image:render' && args[0].session === 'page-chat') {
        held = true
        ;(globalThis as any).__activeFake.releaseKeyboardImage = () => send(channel, ...args)
      } else send(channel, ...args)
    }
  })
  await input.evaluate((n) => {
    for (const repeat of [false, false, true, false]) {
      n.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', repeat, bubbles: true, cancelable: true }),
      )
      n.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
    }
  })
  await expect
    .poll(() => app.evaluate(() => typeof (globalThis as any).__activeFake.releaseKeyboardImage))
    .toBe('function')
  await input.press('Enter')
  await expect(page.locator('.page-chat [role="alert"]')).toHaveCount(0)
  await app.evaluate(() => (globalThis as any).__activeFake.releaseKeyboardImage())
  await expect(page.locator('.chat-turn')).toHaveCount(1)
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'streaming')
  expect((await state()).chatCalls).toHaveLength(1)
  expect(stored()[0].question).toBe('한글 조합 질문')
  await input.fill('다음 질문')
  await input.press('Enter')
  await input.evaluate((n) => (n as HTMLTextAreaElement).form!.requestSubmit())
  await expect(input).toHaveValue('다음 질문')
  expect((await state()).chatCalls).toHaveLength(1)
  await expect(page.locator('.page-chat [role="alert"]')).toHaveCount(0)
  await page.getByRole('button', { name: '응답 중지' }).click()
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'stopped')
  await set({ chatMode: 'normal' })
  await input.press('Enter')
  await expect(page.locator('.chat-turn')).toHaveCount(2)
  await expect(page.locator('.chat-turn').last()).toHaveAttribute('data-status', 'complete')
  expect((await state()).chatCalls).toHaveLength(2)
})

test('image preparation stays on its original document/page after viewer switches, including late streamed output', async () => {
  await connectFakeChatGPT(page)
  await add()
  await add('B')
  await open()
  await chat()
  await set({ chatMode: 'hold' })
  await app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents,
      send = wc.send.bind(wc)
    wc.send = (channel: string, ...args: any[]) => {
      if (channel === 'image:render' && args[0].session === 'page-chat') {
        ;(globalThis as any).__activeFake.releaseChatImage = () => send(channel, ...args)
      } else send(channel, ...args)
    }
  })
  await send('원래 페이지 질문')
  await expect
    .poll(() => app.evaluate(() => typeof (globalThis as any).__activeFake.releaseChatImage))
    .toBe('function')
  await open('B')
  await chat()
  await go(2)
  const input = page.getByRole('textbox', { name: '질문', exact: true })
  await input.fill('other tab draft')
  const currentPage = page.getByRole('textbox', { name: '현재 페이지', exact: true })
  await currentPage.click()
  await app.evaluate(() => (globalThis as any).__activeFake.releaseChatImage())
  await expect.poll(async () => (await state()).chatCalls.length).toBe(1)
  const call = (await state()).chatCalls[0]
  expect(JSON.parse(call.input[0].content[0].text)).toMatchObject({
    documentName: 'A.pdf',
    page: 1,
  })
  await expect(page.locator('.chat-turn')).toHaveCount(0)
  await expect(input).toHaveValue('other tab draft')
  await expect(currentPage).toBeFocused()
  await advance()
  await finish()
  await expect
    .poll(() => stored().find((r: any) => r.question === '원래 페이지 질문')?.status)
    .toBe('complete')
  await expect(page.locator('.chat-turn')).toHaveCount(0)
  await expect(currentPage).toBeFocused()
  await page.locator('.document-tab').first().getByRole('tab').click()
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('')
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'complete')
  await expect(page.locator('.chat-question')).toContainText('원래 페이지 질문')
})

test('main composer focus stays neutral as Tab cycles sidebar tabs while mouse editing and image failure retain the question', async ({}, info) => {
  await connectFakeChatGPT(page)
  await add()
  await open()
  await chat()
  const shell = page.locator('.chat-input-shell'),
    input = page.getByRole('textbox', { name: '질문', exact: true })
  const focusStyle = () =>
    shell.evaluate((node) => {
      const s = getComputedStyle(node)
      return {
        border: s.borderColor,
        outline: s.outlineStyle === 'none' ? 0 : parseFloat(s.outlineWidth),
        shadow: s.boxShadow,
      }
    })
  const initial = await focusStyle()
  await input.click()
  expect(await focusStyle()).toEqual(initial)
  await input.press('Shift+Tab')
  await expect(page.getByRole('tab', { name: '번역', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await page.keyboard.press('Tab')
  await expect(page.getByRole('tab', { name: '채팅', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(input).toBeFocused()
  expect(await focusStyle()).toEqual(initial)
  await input.click()
  await expect(input).toBeFocused()
  await input.fill('가나다 abc')
  await input.press('ArrowLeft')
  expect(await input.evaluate((n: HTMLTextAreaElement) => n.selectionStart)).toBe(6)
  expect(await focusStyle()).toEqual(initial)
  await expect(page.locator('.attachment-picker')).toHaveCount(0)
  await expect(page.locator('.chat-attachment-space,.chat-attachment-control')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('automatic-page-image-composer.png') })
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('page-chat:image-source')
    ipcMain.handle('page-chat:image-source', () => ({
      status: 'error',
      message: 'fake image failure',
    }))
  })
  await send('실패할 이미지 질문')
  await expect(page.getByRole('alert')).toContainText('페이지 이미지를 만들지 못했어요')
  expect((await state()).chatCalls).toHaveLength(0)
  expect(stored()).toHaveLength(0)
  await expect(input).toHaveValue('실패할 이미지 질문')
})

test('automatic-image composer remains usable in every theme at minimum width without changing PDF or saved turns', async ({}, info) => {
  await connectFakeChatGPT(page)
  await add()
  await open()
  await chat()
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1000, 680),
  )
  await dragPanel(page)
  await send('테마 확인용 질문')
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'complete')
  const input = page.getByRole('textbox', { name: '질문', exact: true })
  await input.fill('테마를 바꾸어도 유지할 입력\n여러 줄 입력')
  const before = {
    page: await page.getByRole('textbox', { name: '현재 페이지' }).inputValue(),
    zoom: await page.getByTestId('zoom-value').textContent(),
    panel: await page.getByRole('separator').getAttribute('aria-valuenow'),
    turns: stored().length,
    requests: (await state()).chatCalls.length,
  }
  for (const theme of THEME_PALETTE) {
    await page.getByRole('button', { name: '설정', exact: true }).click()
    await page.getByRole('button', { name: '테마 선택', exact: true }).click()
    await page.getByRole('button', { name: theme.name + ' 테마', exact: true }).click()
    await page.getByRole('button', { name: '테마 적용', exact: true }).click()
    await page.getByRole('button', { name: '설정 닫기' }).click()
    await expect(page.locator('.attachment-picker')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '전송', exact: true })).toBeInViewport()
    await page.screenshot({ path: info.outputPath(theme.id + '-image-composer.png') })
    await expect(input).toHaveValue('테마를 바꾸어도 유지할 입력\n여러 줄 입력')
    expect(await page.getByRole('textbox', { name: '현재 페이지' }).inputValue()).toBe(before.page)
    expect(await page.getByTestId('zoom-value').textContent()).toBe(before.zoom)
    expect(await page.getByRole('separator').getAttribute('aria-valuenow')).toBe(before.panel)
    expect(stored()).toHaveLength(before.turns)
    expect((await state()).chatCalls).toHaveLength(before.requests)
  }
})

test('folder moves preserve the open page, zoom, translations, completed chat and cache without scheduling inference', async ({}, info) => {
  await connectFakeChatGPT(page)
  await library()
  await page.getByRole('button', { name: '파일 또는 폴더 추가', exact: true }).click()
  await page.getByRole('menuitem', { name: '폴더', exact: true }).click()
  await page.getByRole('textbox', { name: '폴더 이름' }).fill('수업')
  await page.getByRole('textbox', { name: '폴더 이름' }).press('Enter')
  const folder = page.getByRole('article', { name: '폴더 수업', exact: true })
  await expect(folder).toBeVisible()
  await folder.getByRole('button', { name: '수업 폴더 열기', exact: true }).click()
  await add('A')
  await expect
    .poll(async () =>
      page.evaluate(
        async () => (await window.desktop.listDocuments()).find((d) => d.name === 'A.pdf')?.done,
      ),
    )
    .toBe(3)
  await open('A')
  await go(2)
  await page.getByRole('button', { name: '확대', exact: true }).click()
  const resize = page.getByRole('separator', { name: '번역 패널 너비' })
  await dragPanel(page, 33)
  await chat()
  await send('폴더를 이동해도 이 대화를 유지해 줘')
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'complete')
  const digest = () => {
    const db = new DatabaseSync(join(profile, 'translations/translations.sqlite'))
    try {
      const data = ['translations', 'translation_history', 'page_chats', 'chat_turns'].map(
        (table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      )
      return createHash('sha256').update(JSON.stringify(data)).digest('hex')
    } finally {
      db.close()
    }
  }
  const before = {
    page: await page.getByRole('textbox', { name: '현재 페이지' }).inputValue(),
    zoom: await page.getByTestId('zoom-value').textContent(),
    panel: await resize.getAttribute('aria-valuenow'),
    digest: digest(),
    translations: (await state()).calls.length,
    chats: (await state()).chatCalls.length,
    doc: await page.evaluate(async () =>
      (await window.desktop.listDocuments()).map((d) => ({ id: d.id, lastOpened: d.lastOpened })),
    ),
  }
  await library()
  await page.getByRole('button', { name: /^정렬 기준:/ }).click()
  await page.getByRole('menuitemradio', { name: '이름순', exact: true }).click()
  await folder.getByRole('button', { name: '수업 폴더 열기', exact: true }).click()
  await page.getByRole('button', { name: '상위 폴더로', exact: true }).click()
  await folder.getByRole('button', { name: '수업 폴더 열기', exact: true }).click()
  const row = page.getByRole('article', { name: 'A.pdf', exact: true })
  await row.getByRole('button', { name: /메뉴$/ }).click()
  await page.getByRole('menuitem', { name: '파일 위치 이동', exact: true }).click()
  await page.getByRole('button', { name: '이 위치로 이동', exact: true }).click()
  await expect(row).toHaveCount(0)
  await page
    .getByRole('navigation', { name: '폴더 경로', exact: true })
    .getByRole('button', { name: '최상위', exact: true })
    .click()
  await expect(row.getByText('번역 완료', { exact: true })).toBeVisible()
  await row.getByRole('button', { name: /메뉴$/ }).click()
  await page.getByRole('menuitem', { name: '파일 위치 이동', exact: true }).click()
  await page
    .getByLabel('이동 가능한 하위 폴더', { exact: true })
    .getByRole('button', { name: '수업', exact: true })
    .click()
  await page.getByRole('button', { name: '이 위치로 이동', exact: true }).click()
  await folder.getByRole('button', { name: /메뉴$/ }).click()
  await page.getByRole('menuitem', { name: '폴더 이름 변경', exact: true }).click()
  await page.getByRole('textbox', { name: '폴더 이름' }).fill('이동한 수업')
  await page.getByRole('textbox', { name: '폴더 이름' }).press('Enter')
  await page.getByRole('button', { name: '파일 목록 닫기' }).click()
  expect(await page.getByRole('textbox', { name: '현재 페이지' }).inputValue()).toBe(before.page)
  expect(await page.getByTestId('zoom-value').textContent()).toBe(before.zoom)
  expect(await resize.getAttribute('aria-valuenow')).toBe(before.panel)
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'complete')
  expect(digest()).toBe(before.digest)
  expect(
    await page.evaluate(async () =>
      (await window.desktop.listDocuments()).map((d) => ({ id: d.id, lastOpened: d.lastOpened })),
    ),
  ).toEqual(before.doc)
  expect((await state()).calls.length).toBe(before.translations)
  expect((await state()).chatCalls.length).toBe(before.chats)
  await page.screenshot({ path: info.outputPath('folder-move-reader-chat.png') })
  // Restart and open from the new folder: completed translations and the original
  // conversation still belong to the original document/page, with no inference.
  await app.close()
  await launch()
  await library()
  await page.getByRole('button', { name: '이동한 수업 폴더 열기', exact: true }).click()
  await page
    .getByRole('article', { name: 'A.pdf', exact: true })
    .getByRole('button', { name: /열기$/ })
    .click()
  await expect(page.getByRole('textbox', { name: '현재 페이지' })).toHaveValue('2')
  await chat()
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'complete')
  expect(digest()).toBe(before.digest)
  expect((await state()).calls.length).toBe(0)
  expect((await state()).chatCalls.length).toBe(0)
})

test('chat edge layout keeps first and last messages clear beside a growing composer', async ({}, info) => {
  await connectFakeChatGPT(page)
  await add()
  await open()
  await chat()
  const messages = page.getByRole('log', { name: '페이지 대화', exact: true })
  const input = page.getByRole('textbox', { name: '질문', exact: true })
  const shell = page.locator('.chat-input-shell')
  const measurements: unknown[] = []
  const boundary = async (label: string, edge: 'top' | 'bottom' | 'both') => {
    const bounds = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect()
      const bar = rect('.language-bar'),
        history = rect('.chat-history'),
        log = rect('.chat-messages'),
        first = rect('.chat-question'),
        last = rect('.chat-turn:last-child'),
        shell = rect('.chat-input-shell'),
        text = rect('.chat-input-shell textarea'),
        send = rect('.chat-send'),
        card = rect('.translation-panel')
      const top = getComputedStyle(document.querySelector('.language-bar')!, '::after'),
        bottom = getComputedStyle(document.querySelector('.chat-history')!, '::after'),
        blur = getComputedStyle(document.querySelector('.chat-history')!, '::before'),
        reader = getComputedStyle(document.querySelector('.reader-controls')!, '::after')
      return {
        topClearance: first.top - bar.bottom - parseFloat(top.height),
        bottomClearance: history.bottom - parseFloat(bottom.height) - last.bottom,
        inputGap: shell.top - history.bottom,
        logGap: history.bottom - log.bottom,
        leftInset: text.left - shell.left,
        rightInset: shell.right - send.right,
        inputBottomInset: card.bottom - shell.bottom,
        topMask: top.maskImage,
        bottomMask: bottom.maskImage,
        blurMask: blur.maskImage,
        topHeight: parseFloat(top.height),
        bottomHeight: parseFloat(bottom.height),
        readerMask: reader.maskImage,
        readerHeight: reader.height,
        blur: blur.backdropFilter,
        pointer: [top.pointerEvents, bottom.pointerEvents, blur.pointerEvents],
        fieldFilter: getComputedStyle(document.querySelector('.chat-input-shell')!).filter,
        fieldBackdrop: getComputedStyle(document.querySelector('.chat-input-shell')!)
          .backdropFilter,
        sendFilter: getComputedStyle(document.querySelector('.chat-send')!).filter,
        oldBottom: getComputedStyle(document.querySelector('.translation-panel')!, '::after')
          .content,
      }
    })
    if (edge !== 'bottom') expect(bounds.topClearance).toBeGreaterThanOrEqual(8)
    if (edge !== 'top') expect(bounds.bottomClearance).toBeGreaterThanOrEqual(8)
    expect(Math.abs(bounds.inputGap)).toBeLessThan(1)
    expect(Math.abs(bounds.logGap)).toBeLessThan(1)
    expect(bounds.leftInset).toBeGreaterThanOrEqual(8)
    expect(bounds.leftInset).toBeLessThanOrEqual(16)
    expect(bounds.rightInset).toBe(9)
    expect(bounds.inputBottomInset).toBe(23)
    expect(bounds.bottomHeight).toBe(bounds.topHeight)
    expect(bounds.bottomMask).toContain('to top')
    const stops = (mask: string) => mask.replace(/to (?:top|bottom),\s*/, '')
    expect(stops(bounds.bottomMask)).toBe(stops(bounds.topMask))
    expect(bounds.blurMask).toContain('to top')
    expect(bounds.blur).toBe('blur(6px)')
    expect(bounds.pointer).toEqual(['none', 'none', 'none'])
    expect([bounds.fieldFilter, bounds.fieldBackdrop, bounds.sendFilter]).toEqual([
      'none',
      'none',
      'none',
    ])
    expect(bounds.oldBottom).toBe('none')
    measurements.push({ label, ...bounds })
    return bounds
  }
  const scroll = async (edge: 'top' | 'bottom') => {
    await messages.evaluate((node, edge) => {
      node.scrollTop = edge === 'top' ? 0 : node.scrollHeight
      node.dispatchEvent(new Event('scroll'))
    }, edge)
  }
  await send('경계 확인 질문')
  await expect(page.locator('.chat-turn').last()).toHaveAttribute('data-status', 'complete')
  await scroll('top')
  const shared = await boundary('short-single', 'both')
  await input.fill('여러 줄 입력 영역을 확인합니다. '.repeat(12))
  await expect(shell).toHaveAttribute('data-multiline', 'true')
  await boundary('short-multiline', 'both')
  await page.screenshot({ path: info.outputPath('short-multiline.png') })
  await input.fill('')
  await expect(shell).toHaveAttribute('data-multiline', 'false')
  await set({ chatText: '긴 대화의 문단과 수식 $x^2$를 읽습니다.\n\n'.repeat(80) })
  for (const text of ['두 번째 질문', '세 번째 질문']) {
    const count = await page.locator('.chat-turn').count()
    await send(text)
    await expect(page.locator('.chat-turn')).toHaveCount(count + 1)
    await expect(page.locator('.chat-turn').last()).toHaveAttribute('data-status', 'complete')
  }
  expect(await messages.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true)
  await scroll('top')
  await boundary('long-top-single', 'top')
  await page.screenshot({ path: info.outputPath('long-top.png') })
  await input.fill('입력창 높이가 달라져도 읽는 위치를 유지합니다.\n'.repeat(10))
  await expect(shell).toHaveAttribute('data-multiline', 'true')
  expect(await messages.evaluate((node) => node.scrollTop)).toBeLessThan(2)
  await boundary('long-top-multiline', 'top')
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1000, 680),
  )
  await dragPanel(page)
  expect(await messages.evaluate((node) => node.scrollTop)).toBeLessThan(2)
  await boundary('narrow-top-multiline', 'top')
  await scroll('bottom')
  await boundary('narrow-bottom-multiline', 'bottom')
  await page.screenshot({ path: info.outputPath('narrow-bottom-multiline.png') })
  await input.fill('')
  await expect(shell).toHaveAttribute('data-multiline', 'false')
  await scroll('bottom')
  await boundary('narrow-bottom-single', 'bottom')
  await page.screenshot({ path: info.outputPath('narrow-bottom-single.png') })
  await page.getByRole('tab', { name: '번역', exact: true }).click()
  const unchanged = await page.evaluate(() => ({
    top: getComputedStyle(document.querySelector('.language-bar')!, '::after').maskImage,
    bottom: getComputedStyle(document.querySelector('.translation-panel')!, '::after').maskImage,
    height: getComputedStyle(document.querySelector('.translation-panel')!, '::after').height,
    reader: getComputedStyle(document.querySelector('.reader-controls')!, '::after').maskImage,
    readerHeight: getComputedStyle(document.querySelector('.reader-controls')!, '::after').height,
  }))
  expect(unchanged.top).toBe(shared.topMask)
  expect(unchanged.bottom).toBe(shared.bottomMask)
  expect(parseFloat(unchanged.height)).toBe(shared.bottomHeight)
  expect(unchanged.reader).toBe(shared.readerMask)
  expect(unchanged.readerHeight).toBe(shared.readerHeight)
  await writeFile(info.outputPath('boundaries.json'), JSON.stringify(measurements))
})

test('duplicate document tabs share page chat and completed translations while a request stays with its original page', async () => {
  await connectFakeChatGPT(page)
  await pdf('A', 2)
  await pdf('B', 1)
  await add('A')
  await add('B')
  await expect.poll(async () => (await state()).calls.length).toBeGreaterThan(0)
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.desktop.listDocuments())).every(
        (d) => d.status === 'complete',
      ),
    )
    .toBe(true)
  await open('A')
  await expect(page.getByTestId('page-stage')).toHaveAttribute('data-status', 'ready')
  const source = (await page.evaluate(() => window.desktop.listDocuments())).find(
    (d) => d.name === 'A.pdf',
  )!
  const baseline = (await state()).calls.length
  await set({ chatMode: 'hold' })
  await chat()
  await send('탭 전환 중 원래 페이지 질문')
  await expect(page.locator('.chat-answer')).toContainText('첫 번째 조각')
  await open('A')
  await expect(page.locator('.document-tab')).toHaveCount(2)
  await expect(page.locator('.chat-question')).toContainText('탭 전환 중 원래 페이지 질문')
  await go(2)
  await expect(page.locator('.chat-question')).toHaveCount(0)
  await open('B')
  await expect(page.locator('.chat-question')).toHaveCount(0)
  await finish()
  await expect
    .poll(async () => {
      const result = await page.evaluate(
        (documentId) => window.desktop.pageChat({ documentId, page: 1 }),
        source.id,
      )
      return result.status === 'ok' && result.snapshot.turns[0]?.status
    })
    .toBe('complete')
  await expect(page.locator('.chat-question')).toHaveCount(0)
  await page.locator('.document-tab').first().getByRole('tab').click()
  await expect(page.getByTestId('page-stage')).toHaveAttribute('data-status', 'ready')
  await expect(page.locator('.chat-question')).toContainText('탭 전환 중 원래 페이지 질문')
  await expect(page.locator('.chat-answer')).toContainText('기술 용어')
  expect((await state()).calls).toHaveLength(baseline)
  expect((await state()).chatCalls).toHaveLength(1)
  expect(await page.evaluate(() => window.desktop.listDocuments())).toHaveLength(2)
})

for (const phase of ['streaming', 'preparing'] as const)
  test(`library document deletion cancels ${phase} chat and its page image, removes history and cannot restore it through a late event`, async () => {
    await connectFakeChatGPT(page)
    await add('A')
    await expect(
      page
        .getByRole('article', { name: 'A.pdf', exact: true })
        .getByText('번역 완료', { exact: true }),
    ).toBeVisible()
    await open('A')
    await chat()
    const id = (await page.evaluate(() => window.desktop.librarySnapshot())).documents.find(
      (d) => d.name === 'A.pdf',
    )!.id
    await set(
      phase === 'streaming'
        ? { chatMode: 'hold' }
        : { holdSourceChannel: 'page-chat:image-source' },
    )
    const before = (await state()).chatCalls.length
    await send('fake deletion question')
    if (phase === 'streaming')
      await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'streaming')
    else await expect.poll(async () => (await state()).sourceHeld).toBe(1)
    await add('B')
    await page.getByRole('button', { name: 'A.pdf 파일 메뉴', exact: true }).click()
    await page.getByRole('menuitem', { name: '파일 삭제', exact: true }).click()
    await page
      .getByRole('menu', { name: '파일 삭제 확인', exact: true })
      .getByRole('menuitem', { name: '삭제', exact: true })
      .click()
    await expect(page.getByRole('article', { name: 'A.pdf', exact: true })).toHaveCount(0)
    await app.evaluate(() => {
      const s = (globalThis as any).__activeFake
      s.chatFinish?.()
      s.releaseSourceReplies()
    })
    const db = new DatabaseSync(join(profile, 'translations/translations.sqlite'))
    try {
      expect(db.prepare('SELECT COUNT(*) n FROM page_chats WHERE document_id=?').get(id)?.n).toBe(0)
      expect(db.prepare('SELECT COUNT(*) n FROM chat_turns').get()?.n).toBe(0)
      await expect
        .poll(
          () =>
            db
              .prepare("SELECT COUNT(*) n FROM translations WHERE document_id<>? AND status='done'")
              .get(id)?.n,
        )
        .toBe(2)
    } finally {
      db.close()
    }
    expect((await state()).chatCalls.length).toBe(before + (phase === 'streaming' ? 1 : 0))
    await open('B')
    await chat()
    await expect(page.locator('.chat-turn')).toHaveCount(0)
  })

const resetPopup = () => page.getByRole('menu', { name: '대화 초기화 확인', exact: true })
async function showResetConfirmation() {
  await page.getByLabel('채팅 메뉴', { exact: true }).click()
  await page.evaluate(() => {
    ;(window as any).__resetMenuNode = document.querySelector('.translation-menu > div')
  })
  await page.getByRole('button', { name: '현재 페이지 대화 초기화', exact: true }).click()
  await expect(resetPopup()).toContainText('현재 페이지의 대화를 초기화하시겠습니까?')
  expect(
    await page.evaluate(
      () => (window as any).__resetMenuNode === document.querySelector('.translation-menu > div'),
    ),
  ).toBe(true)
}
async function completedResetHistory() {
  await connectFakeChatGPT(page)
  await add('A')
  await expect(
    page
      .getByRole('article', { name: 'A.pdf', exact: true })
      .getByText('번역 완료', { exact: true }),
  ).toBeVisible()
  await open('A')
  await chat()
  await send('page one fake')
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'complete')
  await go(2)
  await send('page two fake')
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'complete')
  await go(1)
}
test('reset confirmation replaces the same dropdown, preserves history on cancel, Escape and outside clicks, and closes on page, document and sidebar changes', async ({}, info) => {
  await completedResetHistory()
  const ids = stored().map((r) => r.id)
  await showResetConfirmation()
  await expect(resetPopup().getByRole('menuitem', { name: '취소', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(resetPopup().getByRole('menuitem', { name: '초기화', exact: true })).toBeFocused()
  await page.keyboard.press('Home')
  await resetPopup().getByRole('menuitem', { name: '취소', exact: true }).press('Enter')
  await expect(resetPopup()).toHaveCount(0)
  expect(stored().map((r) => r.id)).toEqual(ids)
  await showResetConfirmation()
  await page.keyboard.press('Escape')
  await expect(resetPopup()).toHaveCount(0)
  await expect(page.getByLabel('채팅 메뉴', { exact: true })).toBeFocused()
  await showResetConfirmation()
  await page.locator('.chat-question').click()
  await expect(resetPopup()).toHaveCount(0)
  expect(stored().map((r) => r.id)).toEqual(ids)
  await showResetConfirmation()
  await go(2)
  await expect(resetPopup()).toHaveCount(0)
  expect(stored().map((r) => r.id)).toEqual(ids)
  await showResetConfirmation()
  await page.getByRole('tab', { name: '메모', exact: true }).click()
  await expect(resetPopup()).toHaveCount(0)
  await chat()
  await showResetConfirmation()
  await add('B')
  await expect(resetPopup()).toHaveCount(0)
  await open('B')
  await chat()
  await expect(page.locator('.chat-turn')).toHaveCount(0)
  expect(stored().map((r) => r.id)).toEqual(ids)
  await open('A')
  await chat()
  await page.setViewportSize({ width: 1000, height: 680 })
  await dragPanel(page, 27)
  await showResetConfirmation()
  const popup = (await resetPopup().boundingBox())!,
    sidebar = (await page.locator('.translation-panel').boundingBox())!
  expect(popup.x).toBeGreaterThanOrEqual(sidebar.x)
  expect(popup.x + popup.width).toBeLessThanOrEqual(sidebar.x + sidebar.width)
  const buttons = await resetPopup()
    .locator('button')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        width: node.getBoundingClientRect().width,
        top: node.getBoundingClientRect().top,
        bg: getComputedStyle(node).backgroundColor,
      })),
    )
  expect(Math.abs(buttons[0].width - buttons[1].width)).toBeLessThan(1)
  expect(buttons[0].top).toBe(buttons[1].top)
  expect(buttons[0].bg).not.toBe(buttons[1].bg)
  await page.screenshot({ path: info.outputPath('chat-reset-narrow.png') })
  await resetPopup().getByRole('menuitem', { name: '취소', exact: true }).click()
})
test('opening reset confirmation leaves streaming alive; confirming once uses existing cancellation and stored reset without touching the other page or accepting late output', async () => {
  await completedResetHistory()
  await set({ chatMode: 'hold' })
  await send('streaming reset fake')
  await expect(page.locator('.chat-turn').last()).toHaveAttribute('data-status', 'streaming')
  const other = stored().filter((r) => r.page === 2),
    before = stored().map((r) => r.id)
  await showResetConfirmation()
  await advance()
  await expect(page.getByTestId('chat-answer').last()).toContainText('기술 용어')
  expect(stored().map((r) => r.id)).toEqual(before)
  expect((await state()).active).toBe(1)
  await resetPopup().getByRole('menuitem', { name: '취소', exact: true }).click()
  await expect(page.locator('.chat-turn').last()).toHaveAttribute('data-status', 'streaming')
  await showResetConfirmation()
  await resetPopup().getByRole('menuitem', { name: '초기화', exact: true }).dblclick()
  await expect(page.locator('.chat-turn')).toHaveCount(0)
  await finish()
  await expect.poll(async () => (await state()).active).toBe(0)
  expect(stored().filter((r) => r.page === 1)).toEqual([])
  expect(stored().filter((r) => r.page === 2)).toEqual(other)
  await app.close()
  await launch()
  await chat()
  await expect(page.locator('.chat-turn')).toHaveCount(0)
  await go(2)
  await expect(page.locator('.chat-turn')).toHaveAttribute('data-status', 'complete')
})
