/**
 * Check that the bundled skill registers with a usable definition and that every reference
 * page its index names actually exists.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, group } from './lib.mjs'

export async function run() {
  const g = group('skill')
  const registered = []
  const skills = {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  }
  const scopeFor = (names) => ({
    effect: (fn) => fn(),
    get: () => undefined,
    systemPrompt: { section() {} },
    tools: { register() {} },
    skills: names.includes('skills') ? skills : undefined,
  })
  const ctx = {
    effect: (fn) => { const off = fn(); return typeof off === 'function' ? off : () => {} },
    webServer: { register: () => () => {} },
    get: () => undefined,
    inject: (names, callback) => { if (names.includes('skills') && !skills) return; callback(scopeFor(names)) },
    on: () => {},
    logger: { warn() {} },
  }

  const { apply } = await import(pathToFileURL(join(ROOT, 'index.js')).href)
  apply(ctx)

  g.check(registered.length === 1, 'one skill registered', String(registered.length))
  const skill = registered[0]
  if (!skill) return g.results
  g.check(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name), 'skill name is kebab-case', skill.name)
  g.check(typeof skill.description === 'string' && skill.description.length > 40, 'skill description routes the model', `${skill.description?.length ?? 0} chars`)
  g.check(skill.invocation?.modelInvocable === true, 'model can load it')
  g.check(skill.invocation?.userInvocable === true, 'user can invoke it as /name')
  g.check(typeof skill.content === 'string' && skill.content.length > 200, 'skill body present', `${skill.content?.length ?? 0} chars`)
  const base = skill.resourceBase?.path
  g.check(skill.resourceBase?.kind === 'directory' && Boolean(base) && existsSync(base), 'resource base is a real directory', String(base))
  if (!base) return g.results

  const named = [...new Set([...skill.content.matchAll(/references\/([\w.-]+\.md)/g)].map((match) => match[1]))]
  g.check(named.length > 0, 'the index names its reference pages', String(named.length))
  const missing = named.filter((file) => !existsSync(join(base, 'references', file)))
  g.check(missing.length === 0, 'every indexed page exists', missing.join(', ') || 'all present')
  const empty = named.filter((file) => existsSync(join(base, 'references', file)) && readFileSync(join(base, 'references', file), 'utf8').trim().length < 80)
  g.check(empty.length === 0, 'no stub reference pages', empty.join(', ') || 'all have content')
  return g.results
}
