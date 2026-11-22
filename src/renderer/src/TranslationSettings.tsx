import { ChatGPTConnection } from './ChatGPTConnection'
import type { ChatGPTSnapshot } from '../../shared/chatgpt'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, ChevronRight, RefreshCw } from 'lucide-react'
import { DEFAULT_IMAGE_SETTINGS } from '../../shared/contracts'
import type { TranslationSettings as Settings } from '../../shared/contracts'
import { ChatGPTStatus } from './ChatGPTStatus'
import { DEFAULT_THEME, THEME_PALETTE, themePreset } from '../../shared/themes'
import type { ThemeId } from '../../shared/themes'

type SectionId = 'chatgpt' | 'images' | 'theme'

function Section({
  id,
  title,
  summary,
  open,
  toggle,
  headerRef,
  children,
}: {
  id: SectionId
  title: string
  summary: ReactNode
  open: boolean
  toggle: () => void
  headerRef: (node: HTMLButtonElement | null) => void
  children: ReactNode
}) {
  return (
    <section className="settings-section" data-section={id}>
      <h3 className="settings-section-heading">
        <button
          ref={headerRef}
          type="button"
          className="settings-section-trigger"
          aria-label={title}
          aria-expanded={open}
          aria-controls={'settings-panel-' + id}
          id={'settings-heading-' + id}
          onClick={toggle}
        >
          <ChevronRight size={14} className="settings-chevron" aria-hidden="true" />
          <span className="settings-section-title">{title}</span>
          <span className="settings-section-summary">{summary}</span>
        </button>
      </h3>
      <div
        className="settings-section-panel"
        data-open={open}
        id={'settings-panel-' + id}
        role="region"
        aria-labelledby={'settings-heading-' + id}
        aria-hidden={!open}
        inert={!open}
      >
        <div className="settings-section-inner">
          <div
            className="settings-section-content"
            onFocusCapture={(event) => {
              const target = event.target as HTMLElement
              const strip = target.closest<HTMLElement>('.settings-row-scroll')
              if (!strip) return
              const viewport = strip.getBoundingClientRect()
              const control = target.getBoundingClientRect()
              const style = getComputedStyle(strip)
              const left = viewport.left + parseFloat(style.paddingLeft)
              const right = viewport.right - parseFloat(style.paddingRight)
              if (control.left < left) strip.scrollLeft += control.left - left
              else if (control.right > right) strip.scrollLeft += control.right - right
            }}
          >
            {children}
          </div>
        </div>
      </div>
    </section>
  )
}

export function TranslationSettings({
  settings,
  onChange,
  theme,
  onThemeChange,
  initialSection,
}: {
  settings: Settings | null
  onChange: (settings: Settings) => void
  theme: ThemeId
  onThemeChange: (theme: ThemeId) => void
  initialSection?: 'chatgpt' | null
}) {
  const [chatgpt, setChatgpt] = useState<ChatGPTSnapshot | null>(null)
  useEffect(() => {
    let live = true
    const update = () => {
      void window.desktop
        .chatgptSnapshot()
        .then((s) => {
          if (live) setChatgpt(s)
        })
        .catch(() => {})
    }
    update()
    const timer = window.setInterval(update, 500)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [])
  const [open, setOpen] = useState<SectionId | null>(initialSection ?? null)
  const currentOpen = useRef(open)
  currentOpen.current = open
  const headers = useRef<Partial<Record<SectionId, HTMLButtonElement | null>>>({})
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<SectionId, string>>>({})
  const [dpi, setDpi] = useState(settings?.images.dpi ?? DEFAULT_IMAGE_SETTINGS.dpi)
  const [selectedTheme, setSelectedTheme] = useState(theme)
  useEffect(() => {
    if (settings) setDpi(settings.images.dpi)
  }, [settings?.images.dpi])
  const close = (id: SectionId) => {
    if (currentOpen.current === id) {
      setOpen(null)
      headers.current[id]?.focus()
    }
  }
  const fail = (id: SectionId, message: string) => {
    setErrors((p) => ({ ...p, [id]: message }))
    if (currentOpen.current !== id) headers.current[id]?.focus()
    setOpen(id)
  }
  const applyImages = async () => {
    if (busy) return
    setBusy(true)
    setErrors((p) => ({ ...p, images: undefined }))
    try {
      const result = await window.desktop.configureImages({
        ...(settings?.images ?? DEFAULT_IMAGE_SETTINGS),
        dpi,
      })
      if (result.status === 'error') fail('images', result.message)
      else {
        onChange(result.settings)
        close('images')
      }
    } catch {
      fail('images', '이미지 설정을 적용하지 못했어요.')
    } finally {
      setBusy(false)
    }
  }
  const saveTheme = async () => {
    if (busy) return
    setBusy(true)
    setErrors((p) => ({ ...p, theme: undefined }))
    try {
      const r = await window.desktop.configureTheme(selectedTheme)
      if (r.status === 'error') fail('theme', r.message)
      else {
        onThemeChange(r.theme)
        close('theme')
      }
    } catch {
      fail('theme', '테마를 저장하지 못했어요. 다시 시도해 주세요.')
    } finally {
      setBusy(false)
    }
  }
  const section = (id: SectionId, title: string, summary: ReactNode, children: ReactNode) => (
    <Section
      id={id}
      title={title}
      summary={summary}
      open={open === id}
      toggle={() => setOpen((p) => (p === id ? null : id))}
      headerRef={(node) => {
        headers.current[id] = node
      }}
    >
      {children}
      {errors[id] && (
        <p className="settings-error" role="alert">
          {errors[id]}
        </p>
      )}
    </Section>
  )
  const appliedTheme = themePreset(theme)
  return (
    <div className="settings-body">
      {section(
        'chatgpt',
        'ChatGPT 연결',
        <ChatGPTStatus settings={settings} />,
        <ChatGPTConnection
          state={chatgpt}
          refresh={setChatgpt}
          onConfirm={() => close('chatgpt')}
        />,
      )}
      {section(
        'images',
        '번역 이미지 설정',
        settings ? '해상도 ' + settings.images.dpi + ' DPI' : '불러오는 중',
        <form
          className="settings-form settings-row-scroll"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            void applyImages()
          }}
        >
          <div className="settings-control-row">
            <label className="settings-dpi-label" htmlFor="settings-image-dpi">
              이미지 해상도 (DPI)
            </label>
            <div className="settings-row-actions">
              <input
                id="settings-image-dpi"
                title="이미지 해상도 (DPI)"
                className="settings-dpi"
                type="number"
                min={96}
                max={300}
                step={1}
                value={dpi}
                onChange={(e) => setDpi(Number(e.target.value))}
              />
              <button
                type="button"
                className="settings-icon-button settings-refresh"
                title="이미지 기본값으로 복귀"
                aria-label="이미지 기본값으로 복귀"
                disabled={busy}
                onClick={() => {
                  setDpi(DEFAULT_IMAGE_SETTINGS.dpi)
                  setErrors((p) => ({ ...p, images: undefined }))
                }}
              >
                <RefreshCw size={16} aria-hidden="true" />
              </button>
              <button
                type="submit"
                className="settings-icon-button settings-confirm"
                disabled={busy}
                title="이미지 설정 적용"
                aria-label="이미지 설정 적용"
              >
                <Check size={17} aria-hidden="true" />
              </button>
            </div>
          </div>
        </form>,
      )}
      {section(
        'theme',
        '테마 선택',
        <span
          className="theme-applied-dot"
          role="img"
          aria-label={'현재 테마: ' + appliedTheme.name}
          title={'현재 테마: ' + appliedTheme.name}
          style={{ backgroundColor: appliedTheme.color }}
        />,
        <div className="settings-row-scroll">
          <div className="settings-control-row">
            <div className="theme-palette" role="group" aria-label="테마 색상">
              {THEME_PALETTE.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="theme-swatch"
                  aria-label={entry.name + ' 테마'}
                  title={entry.name}
                  aria-pressed={selectedTheme === entry.id}
                  style={{ backgroundColor: entry.color }}
                  disabled={busy}
                  onClick={() => setSelectedTheme(entry.id)}
                />
              ))}
            </div>
            <div className="settings-row-actions">
              <button
                type="button"
                className="settings-icon-button settings-refresh"
                title="테마 기본값으로 복귀"
                aria-label="테마 기본값으로 복귀"
                disabled={busy}
                onClick={() => {
                  setSelectedTheme(DEFAULT_THEME)
                  setErrors((p) => ({ ...p, theme: undefined }))
                }}
              >
                <RefreshCw size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="settings-icon-button settings-confirm"
                title="테마 적용"
                aria-label="테마 적용"
                disabled={busy}
                onClick={() => void saveTheme()}
              >
                <Check size={17} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>,
      )}
    </div>
  )
}
