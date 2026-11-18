/**
 * Shared bits for the repository self-checks: a tiny assertion collector and the repo root.
 */
import { fileURLToPath } from 'node:url'

/** Absolute path of the plugin repository (one level above scripts/). */
export const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Collect checks for one area.
 * @param {string} area - group label.
 * @returns {{ area: string, check: (ok: boolean, label: string, detail?: string) => void, results: { area: string, ok: boolean, label: string, detail: string }[] }}
 */
export function group(area) {
  const results = []
  return {
    area,
    results,
    check(ok, label, detail = '') {
      results.push({ area, ok: Boolean(ok), label, detail })
    },
  }
}
