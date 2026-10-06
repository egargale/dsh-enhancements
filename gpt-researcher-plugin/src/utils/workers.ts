/**
 * Concurrency, rate limiting, and text helpers.
 *
 * `WorkerPool` ports upstream `utils/workers.py`: a semaphore bounds how many
 * scrapes run at once, and a *process-global* rate limiter enforces a minimum
 * gap between requests across every pool, so a deep-research fan-out cannot
 * overwhelm a rate-limited API.
 *
 * @module gpt-researcher/utils/workers
 */

import type { Logger } from '../types.ts'

/**
 * A process-global minimum-interval limiter, ported from upstream
 * `utils/rate_limiter.py` (a singleton shared by every `WorkerPool`).
 */
export class RateLimiter {
  private delayMs = 0
  private nextSlot = 0

  /** Configure the minimum gap in seconds (0 disables limiting). */
  configure(delaySeconds: number): void {
    this.delayMs = Number.isFinite(delaySeconds) && delaySeconds > 0 ? delaySeconds * 1000 : 0
  }

  /** Current minimum gap, in milliseconds. */
  get intervalMs(): number {
    return this.delayMs
  }

  /**
   * Wait until the next allowed slot.
   *
   * @param now - injectable clock, for deterministic tests.
   */
  async wait(now: () => number = Date.now): Promise<void> {
    if (this.delayMs === 0) return
    const current = now()
    const slot = Math.max(this.nextSlot, current)
    this.nextSlot = slot + this.delayMs
    const waitMs = slot - current
    if (waitMs > 0) await sleep(waitMs)
  }
}

/** The process-global limiter every pool shares. */
export const globalRateLimiter = new RateLimiter()

/**
 * A bounded-concurrency runner with a shared rate limit.
 *
 * Unlike upstream's thread-pool-backed version this is fully async, which is
 * what the Node HTTP seam needs; the observable contract (max in-flight work,
 * global inter-request gap, results in input order) is the same.
 */
export class WorkerPool {
  readonly maxWorkers: number
  readonly rateLimitDelay: number
  private readonly limiter: RateLimiter

  constructor(maxWorkers: number, rateLimitDelay = 0, limiter: RateLimiter = globalRateLimiter) {
    this.maxWorkers = Math.max(1, Math.floor(maxWorkers))
    this.rateLimitDelay = rateLimitDelay
    this.limiter = limiter
    // Only a pool that actually asks for a delay may (re)configure the shared
    // limiter. Unconditionally calling `configure(rateLimitDelay)` meant any
    // default-delay pool — a deep-research or multi-agent fan-out — reset the
    // process-wide gap to 0 and silently disabled `SCRAPER_RATE_LIMIT_DELAY`
    // for the still-running scraper pool that shares this limiter.
    if (rateLimitDelay > 0) limiter.configure(rateLimitDelay)
  }

  /**
   * Run one task per item with at most {@link maxWorkers} in flight, waiting on
   * the shared limiter before each start.
   *
   * A throwing task resolves to the `fallback` value (upstream logs and
   * continues); it never rejects the whole batch.
   *
   * @param items - inputs, processed in order.
   * @param task - the per-item async work.
   * @param options - `fallback` value for a failed item, `logger`, `signal`, `now`.
   * @returns results in input order.
   */
  async map<T, R>(
    items: readonly T[],
    task: (item: T, index: number) => Promise<R>,
    options: {
      fallback?: R
      logger?: Logger
      signal?: AbortSignal
      onSettled?: (index: number, result: R) => void
      now?: () => number
    } = {},
  ): Promise<R[]> {
    const results = new Array<R>(items.length)
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= items.length) return
        if (options.signal?.aborted) return
        await this.limiter.wait(options.now ?? Date.now)
        if (options.signal?.aborted) return
        try {
          const value = await task(items[index] as T, index)
          results[index] = value
          options.onSettled?.(index, value)
        } catch (error) {
          options.logger?.warn(
            `worker task ${index} failed: ${error instanceof Error ? error.message : String(error)}`,
          )
          results[index] = options.fallback as R
          options.onSettled?.(index, options.fallback as R)
        }
      }
    }
    const workerCount = Math.min(this.maxWorkers, Math.max(1, items.length))
    await Promise.all(Array.from({ length: workerCount }, worker))
    // Aborting is not "every item failed": callers filter the `fallback` value
    // to mean "this item failed", so returning a hole-filled array here let a
    // cancelled run continue through compression, curation and report writing
    // and publish a plausible partial outcome. Cancellation must be observable.
    if (options.signal?.aborted) {
      const reason = options.signal.reason
      throw reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError')
    }
    return results
  }
}

/**
 * Sleep for a number of milliseconds, abortable through a signal.
 *
 * The listener is released on both paths. Retaining it until abort (the earlier
 * behaviour) accumulated one listener per rate-limited request on the run's
 * long-lived signal — a 1000-URL scrape left 1000 closures attached.
 *
 * @param ms - milliseconds to wait.
 * @param signal - optional cancellation.
 * @returns a promise that settles when the timer fires or the signal aborts.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/** Total character count of a mixed context value, for compression thresholds. */
export function contextSize(value: unknown): number {
  if (value == null) return 0
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + contextSize(item), 0)
  if (typeof value === 'object') return JSON.stringify(value).length
  return String(value).length
}
