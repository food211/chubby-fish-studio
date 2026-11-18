#!/usr/bin/env node
/**
 * Repository self-checks.
 *
 *   node scripts/check.mjs           run everything, non-zero exit on any failure
 *   node scripts/check.mjs locale    run one group (package, locale, skill, draw)
 *
 * These are development checks: they read the repository, never touch the running app, and
 * need no panel — the draw check stands up a fake one over the same routes.
 */
import { run as checkPackage } from './check-package.mjs'
import { run as checkLocale } from './check-locale.mjs'
import { run as checkSkill } from './check-skill.mjs'
import { run as checkDraw } from './check-draw.mjs'

const groups = { package: checkPackage, locale: checkLocale, skill: checkSkill, draw: checkDraw }
const wanted = process.argv.slice(2).filter((name) => !name.startsWith('-'))
const selected = wanted.length ? wanted : Object.keys(groups)

const unknown = selected.filter((name) => !groups[name])
if (unknown.length) {
  console.error(`unknown check(s): ${unknown.join(', ')}. Available: ${Object.keys(groups).join(', ')}`)
  process.exit(2)
}

const results = []
for (const name of selected) {
  const found = await groups[name]()
  results.push(...found)
  const failed = found.filter((item) => !item.ok).length
  console.log(`\n${name}: ${found.length - failed}/${found.length} passed`)
  for (const item of found) {
    if (item.ok) continue
    console.log(`  FAIL ${item.label}${item.detail ? ' — ' + item.detail : ''}`)
  }
}

const failures = results.filter((item) => !item.ok)
console.log(`\n${results.length - failures.length}/${results.length} checks passed`)
process.exit(failures.length ? 1 : 0)
