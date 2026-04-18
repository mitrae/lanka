/**
 * Exponential backoff capped at 30 seconds. Used by the reconciler to
 * space out retries when the manifest fetch fails. Reset the `attempt`
 * argument to 0 on any successful fetch.
 */
export function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000)
}
