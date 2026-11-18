/**
 * Check the package against the DSH bundle contract: manifest, patch row, locale metadata,
 * the single-image detail page, the icon, the Host export form and files coverage.
 *
 * The rules come from the dsh-doc references (host-plugin.md, plugin-details.md, artwork.md).
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, group } from './lib.mjs'

export async function run() {
  const g = group('package')
  const read = (file) => readFileSync(join(ROOT, file), 'utf8')
  const size = (file) => statSync(join(ROOT, file)).size
  const pkg = JSON.parse(read('package.json'))

  g.check(pkg.name && pkg.version, 'manifest: name + version', `${pkg.name}@${pkg.version}`)
  g.check(pkg.type === 'module', 'manifest: type module')
  g.check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'manifest: dsh.bundle.patch', String(pkg.dsh?.bundle?.patch))
  g.check(pkg.exports?.['.'] === './index.js', 'manifest: exports "." -> index.js')
  g.check(pkg.exports?.['./locale/*.json'] === './locale/*.json', 'manifest: exports locale')
  g.check(pkg.exports?.['./icon'] === './icon.svg' || typeof pkg.icon === 'string', 'manifest: icon export')
  g.check(Array.isArray(pkg.files) && pkg.files.length > 0, 'manifest: files array', (pkg.files || []).join(', '))

  const patch = read('cordis.patch.yml')
  g.check(patch.includes('- insert:'), 'patch: has an insert list')
  g.check(patch.includes(`name: '${pkg.name}'`), 'patch: row name equals package name')
  g.check(/^\s+- id: chubby-fish-studio$/m.test(patch), 'patch: row id')

  for (const file of ['locale/en.json', 'locale/zh.json']) {
    let meta
    try { meta = JSON.parse(read(file)).meta } catch (error) { g.check(false, `${file}: parses`, String(error.message)); continue }
    g.check(Boolean(meta?.title), `${file}: meta.title`, meta?.title)
    g.check(Boolean(meta?.description) && meta.description.length > 40, `${file}: meta.description`, `${meta?.description?.length ?? 0} chars`)
    const detail = meta?.detail
    const detailOk = typeof detail === 'string' && detail.startsWith('docs/') && /\.(md|markdown)$/.test(detail) && existsSync(join(ROOT, detail))
    g.check(detailOk, `${file}: meta.detail exists and is a markdown path`, String(detail))
    if (!detailOk) continue
    const bytes = size(detail)
    g.check(bytes < 1024 * 1024, `${file}: detail under detailMaxBytes (1 MiB)`, `${bytes} bytes`)
    const lines = read(detail).split('\n').filter((line) => line.trim())
    const image = lines.length === 1 ? /^!\[[^\]]+\]\(([^)]+)\)$/.exec(lines[0]) : null
    g.check(Boolean(image), `${file}: document is exactly one image line`, `${lines.length} non-empty line(s)`)
    if (!image) continue
    const imagePath = join(ROOT, 'docs', image[1])
    g.check(existsSync(imagePath), `${file}: image beside the document`, image[1])
    if (!existsSync(imagePath)) continue
    g.check(statSync(imagePath).size < 5 * 1024 * 1024, `${file}: image under detailImageMaxBytes (5 MiB)`, `${statSync(imagePath).size} bytes`)
    if (image[1].endsWith('.svg')) {
      const svg = readFileSync(imagePath, 'utf8')
      const bad = ['<script', '<text', '<style', '<foreignObject', '<animate', '<font'].filter((needle) => svg.includes(needle))
      const remote = /(?:href|src)="(?!data:)(?:https?:|\/\/)/.test(svg)
      g.check(bad.length === 0 && !remote, `${file}: preview is self-contained (embedded data only)`, bad.join(', ') || (remote ? 'remote reference' : 'clean'))
    }
  }

  const iconFile = typeof pkg.icon === 'string' ? pkg.icon : (pkg.exports?.['./icon'] || '').replace(/^\.\//, '')
  g.check(Boolean(iconFile) && existsSync(join(ROOT, iconFile)), 'icon: file exists', iconFile)
  if (iconFile && existsSync(join(ROOT, iconFile))) {
    const svg = read(iconFile)
    g.check(size(iconFile) <= 256 * 1024, 'icon: under 256 KiB', `${size(iconFile)} bytes`)
    const bad = ['<script', '<text', '<style', '<image', '<foreignObject', 'onclick'].filter((needle) => svg.includes(needle))
    g.check(bad.length === 0, 'icon: no text/style/image/script', bad.join(', ') || 'clean')
    g.check(/viewBox="0 0 36 36"/.test(svg), 'icon: 36x36 viewBox')
  }

  const mod = await import(pathToFileURL(join(ROOT, 'index.js')).href)
  g.check(typeof mod.apply === 'function', 'host: exports apply(ctx)')
  g.check(Array.isArray(mod.inject) && mod.inject.includes('webServer'), 'host: declares inject', String(mod.inject))

  const covered = (file) => (pkg.files || []).some((entry) => file === entry || file.startsWith(entry.replace(/\/\*.*$/, '') + '/'))
  const required = [
    'index.js', 'client.js', 'polygon-fill.js', 'cordis.patch.yml', 'icon.svg',
    'locale/en.json', 'locale/zh.json', 'docs/DETAIL.md', 'docs/DETAIL.zh.md',
    'docs/preview.svg', 'skills/canvas-studio/SKILL.md',
  ]
  const missing = required.filter((file) => !covered(file))
  g.check(missing.length === 0, 'files: covers every runtime asset', missing.join(', ') || 'all covered')

  g.check(existsSync(join(ROOT, 'README.md')), 'readme: present for the fallback page')
  g.check(pkg.description && pkg.description.length > 40, 'manifest: top-level description', `${pkg.description?.length ?? 0} chars`)
  return g.results
}
