import type { PageImage } from '../../shared/contracts'
import { responseSchema } from '../batching'
import { chatgptInstruction } from './instructions'

export interface PageImageInput {
  page: number
  part: 1
  image: PageImage
}
export function pageMetadata(page: number, image = 1) {
  return { page, part: 1, region: { x: 0, y: 0, width: 1, height: 1 }, readingOrder: [], image }
}
// Shared by the actual request and byte planner. No extracted source text enters this boundary.
export function translationRequestBody(model: string, images: PageImageInput[]): string {
  return JSON.stringify({
    model,
    instructions: chatgptInstruction,
    store: false,
    stream: true,
    input: [
      {
        role: 'user',
        content: images.flatMap((p, i) => [
          { type: 'input_text', text: JSON.stringify(pageMetadata(p.page, i + 1)) },
          {
            type: 'input_image',
            image_url: `data:${p.image.mimeType};base64,${p.image.data}`,
            detail: 'high',
          },
        ]),
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'page_translation',
        strict: true,
        schema: responseSchema,
      },
    },
  })
}
