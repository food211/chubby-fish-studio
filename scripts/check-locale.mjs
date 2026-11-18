/**
 * Check that the panel's text is fully routed through the Client locale service: every key
 * used with t() has a Chinese entry, and none of the old navigator-based helpers survived.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, group } from './lib.mjs'

export async function run() {
  const g = group('locale')
  const src = readFileSync(join(ROOT, 'build/runtime.js'), 'utf8')

  const dictStart = src.indexOf('    const DICT_ZH = {')
  const dictEnd = src.indexOf('\n    };', dictStart)
  if (dictStart === -1 || dictEnd === -1) { g.check(false, 'dictionary present in build/runtime.js'); return g.results }
  const dict = new Function(`return ({${src.slice(dictStart + '    const DICT_ZH = {'.length, dictEnd)}});`)()
  const dictKeys = new Set(Object.keys(dict))
  g.check(dictKeys.size > 0, 'dictionary entries', String(dictKeys.size))

  const used = new Set()
  for (const match of src.matchAll(/[^A-Za-z0-9_$]t\('((?:[^'\\]|\\.)*)'/g)) used.add(match[1].replace(/\\(.)/g, '$1'))
  // The instruction list keeps its keys in an array rather than inline calls.
  const listStart = src.indexOf('    const INSTRUCTION_KEYS = [')
  const listEnd = src.indexOf('];', listStart)
  if (listStart !== -1 && listEnd !== -1) {
    for (const match of src.slice(listStart, listEnd).matchAll(/'((?:[^'\\]|\\.)*)'/g)) used.add(match[1].replace(/\\(.)/g, '$1'))
  }

  const missing = [...used].filter((key) => !dictKeys.has(key))
  const unused = [...dictKeys].filter((key) => !used.has(key))
  g.check(used.size > 0, 'keys used at call sites', String(used.size))
  g.check(missing.length === 0, 'every used key has a translation', missing.length ? missing.join(' | ') : 'none missing')
  g.check(unused.length === 0, 'no stale translations', unused.length ? unused.join(' | ') : 'none unused')

  const bareCalls = (src.match(/[^A-Za-z0-9_$]L\(/g) || []).length
  g.check(bareCalls === 0, 'no leftover L(en, zh) helper', `${bareCalls} call(s)`)
  g.check(!src.includes('withLang'), 'no leftover withLang helper')
  const navigatorUse = [...src.matchAll(/navigator\.(language|languages)/g)].length
  g.check(navigatorUse === 0, 'panel chrome does not read navigator', `${navigatorUse} use(s)`)
  g.check(src.includes('ctx.locale.register('), 'dictionary is registered with ctx.locale')
  g.check(src.includes('ctx.locale.bind('), 'translator comes from ctx.locale.bind')
  g.check(src.includes('ctx.locale.subscribe') || src.includes("'locale/change'"), 'language changes are subscribed')
  return g.results
}
