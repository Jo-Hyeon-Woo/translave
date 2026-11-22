// The application's sole production route. Gemini remains available as an inactive implementation.
export const ACTIVE_TRANSLATION_PROVIDER = 'chatgpt' as const
import { ChatGPTProvider } from './chatgpt/provider'
import type { ChatGPTService } from './chatgpt/service'
import type { TranslationStore } from './store'
import type { ImageRenderer } from '../shared/contracts'
export function createActiveTranslation(
  auth: ChatGPTService,
  store: TranslationStore,
  render: ImageRenderer,
) {
  return new ChatGPTProvider(auth, store, render)
}
