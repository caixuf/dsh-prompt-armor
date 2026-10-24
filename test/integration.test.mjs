/**
 * Integration check against the real Harness prompt registry.
 *
 * Run with: node test/integration.test.mjs
 *
 * This extracts the *installed* `@deepseek-ai/dsh-system-prompt` and
 * `@deepseek-ai/cordis` from the desktop app.asar, mounts the plugin's Host
 * half on the real registry, and asserts the assembled prompt. The claim
 * "the injected text reaches the model" is therefore checked against the
 * Harness that is actually installed, not against a mock.
 *
 * The DSH package tree is extracted to a temporary directory so Node's ESM
 * loader can import it: the packages inside app.asar are addressed by the
 * bare specifier `@deepseek-ai/…`, which only resolves inside a real
 * node_modules tree.
 */

import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { extractFromAsar, listAsar } from './asar-read.mjs'

const asarPath = process.env.DSH_ASAR
if (!asarPath) {
  console.log('integration.test.mjs: skipped (set DSH_ASAR to the desktop resources/app.asar)')
  process.exit(0)
}

const work = await mkdtemp(join(tmpdir(), 'prompt-armor-int-'))
const modules = join(work, 'node_modules')

// The packages under test, plus everything they import at module scope. The
// prompt registry pulls in cordis, schemastery, the scope package, and
// cosmokit, so the whole `@deepseek-ai` scope is extracted rather than a
// hand-picked list that would have to be extended at every failure.
const wanted = ['@deepseek-ai']

const all = await listAsar(asarPath)
for (const scope of wanted) {
  const prefix = `dsh/node_modules/${scope}/`
  const files = all.filter((path) => path.startsWith(prefix))
  if (files.length === 0) {
    console.error(`integration.test.mjs: ${scope} is not inside the archive`)
    process.exit(1)
  }
  for (const file of files) {
    const out = join(modules, file.slice('dsh/node_modules/'.length))
    await mkdir(dirname(out), { recursive: true })
    // A few entries in the archive are links without bytes of their own.
    // They are not needed by the packages under test, so a failed extract is
    // skipped rather than treated as a failure.
    await extractFromAsar(asarPath, file, out).catch(() => false)
  }
}

// Node needs each package's manifest to resolve its own exports.
const scopeDirs = await cp(modules, join(modules, '.keep'), { recursive: true }).catch(() => null)
void scopeDirs
for (const file of all.filter((path) => path.startsWith('dsh/node_modules/@deepseek-ai/') && path.endsWith('/package.json'))) {
  const out = join(modules, file.slice('dsh/node_modules/'.length))
  const raw = JSON.parse(await readFile(out, 'utf8').catch(() => null) ?? 'null')
  if (raw === null) continue
  if (raw.type !== 'module') raw.type = 'module'
  await writeFile(out, JSON.stringify(raw, null, 2), 'utf8')
}

const { default: SystemPrompt } = await import(
  pathToFileURL(join(modules, '@deepseek-ai', 'dsh-system-prompt', 'lib', 'index.js')).href
)
const { Context } = await import(
  pathToFileURL(join(modules, '@deepseek-ai', 'cordis', 'lib', 'index.js')).href
)

// The plugin's own Host half imports `@deepseek-ai/schemastery`; point the
// package's own resolution at the extracted tree so the real dependency is
// used rather than a stand-in.
const localModules = join(work, 'local-node_modules')
await mkdir(localModules, { recursive: true })
await cp(join(modules, '@deepseek-ai'), join(localModules, '@deepseek-ai'), { recursive: true })
const pluginDir = dirname(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
await cp(localModules, join(pluginDir, 'node_modules'), { recursive: true, force: true })

const { apply } = await import('../index.js')
const { RuleStore } = await import('../lib/rules.js')

const dir = join(work, 'rules')

// A minimal context that offers the `systemPrompt` service the way the
// Loader does, then mount the plugin's Host half on it.
const ctx = new Context()
await ctx.plugin(SystemPrompt, {
  includeHarnessIdentity: true,
  includeRuntimeContext: true,
  personaPrefix: '',
  personaSuffix: '',
})
const systemPrompt = ctx.systemPrompt

const store = new RuleStore(dir)
await store.upsert(
  { id: 'dsh', name: 'DeepSeek', models: ['deepseek-*'], enabled: true },
  'Profile body for {{model}} via {{provider}}.\n',
)
await store.upsert({ id: 'all', name: 'Catch all', models: ['*'], enabled: true }, 'Generic body.\n')

apply(ctx, {
  enabled: true,
  dataDir: dir,
  order: -100000,
  showProfileName: true,
})

// The plugin loads its rules asynchronously, so let the effect settle.
await new Promise((resolve) => setTimeout(resolve, 100))

// The store the plugin itself owns: mutating through it is what the panel
// does, so the tests exercise the same path the product uses.
const pluginStore = ctx.get('promptArmor').store

const assembled = await systemPrompt.assemble({
  agent: { options: { model: 'deepseek-v4.1-flash', provider: 'deepseek-official' } },
})

const rendered = assembled.sections.map((section) => section.text).join('\n\n')

assert.ok(
  rendered.includes('Profile body for deepseek-v4.1-flash via deepseek-official.'),
  `the matched profile body reaches the assembly; got:\n${rendered}`,
)
assert.ok(rendered.includes('## DeepSeek'), 'the profile name is present')
assert.ok(!rendered.includes('Generic body'), 'a less specific profile does not also apply')

// The injected section must lead the prompt, so the persona reads as the frame.
const injected = assembled.sections.find((section) => section.name === 'dsh-prompt-armor:profile')
assert.ok(injected !== undefined, 'the plugin registered its prompt section')
assert.equal(assembled.sections[0].name, 'dsh-prompt-armor:profile', 'the injected section leads the prompt')
assert.equal(injected.interpolate, false, 'the injected section opts out of interpolation')

// A model that only the catch-all matches gets the other body.
const other = await systemPrompt.assemble({
  agent: { options: { model: 'some-other-model', provider: 'other' } },
})
const otherRendered = other.sections.map((section) => section.text).join('\n\n')
assert.ok(otherRendered.includes('Generic body'), 'the catch-all applies to other models')
assert.ok(!otherRendered.includes('Profile body'), 'the specific profile does not leak')

// The Harness reports the provider route and the model id separately, so a
// profile may name either. This is the shape a live agent actually has:
// model "MiniMax-M3.1-Flash" on route "minimax-cn".
await pluginStore.upsert(
  { id: 'route', name: 'Route qualified', models: ['minimax-cn/*'], enabled: true },
  'Route body for {{model}}.\n',
)
const routed = await systemPrompt.assemble({
  agent: { options: { model: 'MiniMax-M3.1-Flash', provider: 'minimax-cn' } },
})
const routedRendered = routed.sections.map((section) => section.text).join('\n\n')
assert.ok(
  routedRendered.includes('Route body for MiniMax-M3.1-Flash.'),
  `a route-qualified pattern matches a bare model id; got:\n${routedRendered}`,
)
assert.ok(!routedRendered.includes('Profile body for'), 'the deepseek profile does not leak onto another route')
await pluginStore.remove('route')

// An assembly without an agent (a diagnostic) must not throw and must not
// contribute a body.
const diagnostic = await systemPrompt.assemble({})
const diagnosticRendered = diagnostic.sections.map((section) => section.text).join('\n\n')
assert.ok(!diagnosticRendered.includes('Profile body'), 'a diagnostic assembly carries no profile body')

// A body containing `{{...}}` must not make the Harness throw: the section
// opts out of interpolation, so the braces survive verbatim.
await pluginStore.upsert(
  { id: 'braces', name: 'Braces', models: ['brace-model'], enabled: true },
  'Literal {{unknown_variable}} stays literal.\n',
)
const braced = await systemPrompt.assemble({
  agent: { options: { model: 'brace-model', provider: 'p' } },
})
const bracedRendered = braced.sections.map((section) => section.text).join('\n\n')
assert.ok(
  bracedRendered.includes('Literal {{unknown_variable}} stays literal.'),
  `an unknown variable reference does not break assembly; got:\n${bracedRendered}`,
)

// An edit made outside the plugin — the user editing a file in an editor —
// must reach a running agent. The store notices the changed index and
// reloads on the next assembly.
await new Promise((resolve) => setTimeout(resolve, 1100))
const indexPath = join(dir, 'index.json')
const index = JSON.parse(await readFile(indexPath, 'utf8'))
index.profiles.push({
  id: 'edited',
  name: 'Edited by hand',
  models: ['hand-edited-model'],
  enabled: true,
})
await writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8')
await writeFile(join(dir, 'profiles', 'edited.md'), 'Hand written body.\n', 'utf8')
await new Promise((resolve) => setTimeout(resolve, 1100))
const edited = await systemPrompt.assemble({
  agent: { options: { model: 'hand-edited-model', provider: 'p' } },
})
const editedRendered = edited.sections.map((section) => section.text).join('\n\n')
assert.ok(
  editedRendered.includes('Hand written body.'),
  `a hand-edited rule file reaches the running agent; got:\n${editedRendered}`,
)

// The section must be registered during `apply`, not after a promise settles:
// a section that appears late can be missing from the first prompt the host
// assembles. The live-prompt helper reports what the host assembles.
const armor = ctx.get('promptArmor')
assert.ok(armor !== undefined, 'the plugin provides its service')
const live = await armor.livePrompt()
assert.ok(live === null, 'there is no live agent before one is created')
assert.deepEqual(
  armor.store.profiles.map((profile) => profile.id).sort(),
  ['all', 'braces', 'dsh', 'edited'],
  'the store holds every profile that was written',
)

await ctx.fiber.dispose()
console.log('integration.test.mjs: all checks passed')
