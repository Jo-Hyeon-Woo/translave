import { randomUUID } from 'node:crypto'
import { validImage } from './batching'
import type { PageImage, RenderRequest } from '../shared/contracts'

export class ImageCapacityError extends Error {}
// Pending entries carry opaque job identities, including independent page-chat renders.
export class ImageBridge {
  private pending = new Map<
    string,
    { finish: (image: PageImage | null, capacity?: boolean) => void }
  >()
  constructor(private dispatch: (request: RenderRequest) => void) {}
  request(input: Omit<RenderRequest, 'requestId'>, signal: AbortSignal): Promise<PageImage> {
    signal.throwIfAborted()
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const finish = (image: PageImage | null, capacity = false) => {
        this.pending.delete(requestId)
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        if (signal.aborted) reject(signal.reason)
        else if (capacity) reject(new ImageCapacityError('image capacity'))
        else if (image && validImage(image)) resolve(image)
        else reject(new Error('image unavailable'))
      }
      const abort = () => finish(null)
      const timer = setTimeout(() => finish(null), 60000)
      this.pending.set(requestId, { finish })
      signal.addEventListener('abort', abort, { once: true })
      try {
        this.dispatch({ ...input, requestId })
      } catch {
        finish(null)
      }
    })
  }
  complete(requestId: string, image: unknown): void {
    const failure = image as { status?: unknown; code?: unknown } | null
    this.pending
      .get(requestId)
      ?.finish(
        validImage(image) ? image : null,
        failure?.status === 'error' && failure.code === 'capacity',
      )
  }
  get size(): number {
    return this.pending.size
  }
}
