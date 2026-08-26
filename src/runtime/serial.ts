import { BrowserRuntimeError } from './error.ts'

/** Per-environment FIFO executor with an explicit close-admission and drain sequence. */
export class SerialExecutor {
  private tail: Promise<void> = Promise.resolve()
  private accepting = true
  private readonly controller = new AbortController()

  /**
   * Enqueue one operation. Calls on the same executor never overlap.
   * @param operation - work receiving caller and lifecycle cancellation.
   * @param signal - optional caller cancellation.
   * @returns the operation result after earlier calls settle.
   */
  run<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!this.accepting) {
      return Promise.reject(new BrowserRuntimeError(
        'browser environment is closing',
        'BROWSER_ENVIRONMENT_CLOSED',
      ))
    }
    const combined = signal === undefined
      ? this.controller.signal
      : AbortSignal.any([this.controller.signal, signal])
    const result = this.tail.then(async () => {
      combined.throwIfAborted()
      return operation(combined)
    })
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  /** Reject new work and abort queued or active provider calls. */
  close(reason?: unknown): void {
    if (!this.accepting) return
    this.accepting = false
    this.controller.abort(reason ?? new BrowserRuntimeError(
      'browser environment is closing',
      'BROWSER_ENVIRONMENT_CLOSED',
    ))
  }

  /** Wait until every admitted operation settles. */
  async drain(): Promise<void> {
    await this.tail
  }
}
