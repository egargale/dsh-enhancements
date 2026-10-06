/**
 * Unit tests for the concurrency primitives.
 *
 * The review that prompted this file found that `WorkerPool.map` treated an
 * abort as "every item failed" (callers filter that value, so a cancelled run
 * continued to completion), that `sleep` retained one abort listener per call,
 * and that any pool created with the default delay silently reset the shared
 * rate limiter — disabling `SCRAPER_RATE_LIMIT_DELAY` process-wide.
 *
 * @module test/unit/workers
 */

import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { describe, it } from 'node:test'

import type { Logger } from '../../src/types.ts'
import { RateLimiter, WorkerPool, sleep } from '../../src/utils/workers.ts'

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** A logger that records warnings. */
function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (message) => warnings.push(message),
    error: () => {},
  }
}

describe('WorkerPool', () => {
  it('processes items in input order and respects the concurrency bound', async () => {
    const pool = new WorkerPool(2)
    let inFlight = 0
    let peak = 0
    const results = await pool.map(
      [1, 2, 3, 4, 5],
      async (item) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 2))
        inFlight -= 1
        return item * 2
      },
      { logger: silentLogger },
    )
    assert.deepEqual(results, [2, 4, 6, 8, 10])
    assert.ok(peak <= 2, `peak concurrency was ${peak}`)
  })

  it('substitutes the fallback for a failed item and keeps going', async () => {
    const logger = recordingLogger()
    const pool = new WorkerPool(2)
    const results = await pool.map(
      [1, 2, 3],
      async (item) => {
        if (item === 2) throw new Error('boom')
        return item
      },
      { fallback: -1, logger },
    )
    assert.deepEqual(results, [1, -1, 3])
    assert.equal(logger.warnings.length, 1)
    assert.match(logger.warnings[0] ?? '', /boom/)
  })

  it('throws the abort reason instead of returning a hole-filled array', async () => {
    const controller = new AbortController()
    const pool = new WorkerPool(2)
    const reason = new Error('caller cancelled')
    const promise = pool.map(
      [1, 2, 3, 4],
      async (item) => {
        if (item === 1) controller.abort(reason)
        await new Promise((resolve) => setTimeout(resolve, 2))
        return item
      },
      { fallback: -1, logger: silentLogger, signal: controller.signal },
    )
    await assert.rejects(promise, /caller cancelled/)
  })

  it('does not start work on an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort(new Error('already aborted'))
    const pool = new WorkerPool(2)
    let calls = 0
    await assert.rejects(
      pool.map(
        [1, 2, 3],
        async () => {
          calls += 1
          return 0
        },
        { fallback: -1, logger: silentLogger, signal: controller.signal },
      ),
      /already aborted/,
    )
    assert.equal(calls, 0)
  })
})

describe('RateLimiter and pool construction', () => {
  it('a zero-delay pool does not reset a configured shared limiter', () => {
    const limiter = new RateLimiter()
    limiter.configure(1) // as BrowserManager does from SCRAPER_RATE_LIMIT_DELAY
    assert.equal(limiter.intervalMs, 1000)
    // A deep-research/multi-agent pool with the default delay used to call
    // configure(0) here and silently disable the scraper's throttling.
    new WorkerPool(4, 0, limiter)
    assert.equal(limiter.intervalMs, 1000)
  })

  it('an explicit non-zero delay still reconfigures the shared limiter', () => {
    const limiter = new RateLimiter()
    new WorkerPool(4, 0.5, limiter)
    assert.equal(limiter.intervalMs, 500)
  })

  it('spaces slots by the configured interval using an injected clock', async () => {
    const limiter = new RateLimiter()
    limiter.configure(0.05)
    let now = 0
    const waits: number[] = []
    const original = setTimeout
    // Observe the wait without actually sleeping the test.
    ;(globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void) => {
      waits.push(now)
      fn()
      return 0 as unknown as NodeJS.Timeout
    }) as typeof setTimeout
    try {
      await limiter.wait(() => {
        now += 10
        return now
      })
      await limiter.wait(() => {
        now += 10
        return now
      })
    } finally {
      ;(globalThis as { setTimeout: typeof setTimeout }).setTimeout = original
    }
    assert.equal(waits.length, 1, 'the second slot must wait for the first to expire')
  })
})

describe('sleep', () => {
  it('removes its abort listener when the timer wins', async () => {
    const controller = new AbortController()
    for (let index = 0; index < 15; index += 1) await sleep(1, controller.signal)
    assert.equal(
      getEventListeners(controller.signal, 'abort').length,
      0,
      'completed sleeps must not retain listeners on the run signal',
    )
  })

  it('resolves early on abort and leaves no listener behind', async () => {
    const controller = new AbortController()
    const pending = sleep(10_000, controller.signal)
    controller.abort()
    await pending
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  })
})
