/**
 * Behavioural checks for the rule store and the model matcher.
 *
 * Run with: node test/rules.test.mjs
 *
 * The matcher decides which prompt a model receives, so its precedence rules
 * are asserted here rather than assumed.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuleStore, isValidId, matchesModel, selectProfile } from '../lib/rules.js'

const dir = await mkdtemp(join(tmpdir(), 'prompt-armor-'))

// --- id validation -------------------------------------------------------

assert.equal(isValidId('ok-id_1.2'), true, 'a plain id is valid')
assert.equal(isValidId(''), false, 'an empty id is invalid')
assert.equal(isValidId('../escape'), false, 'a traversal id is invalid')
assert.equal(isValidId('a/b'), false, 'a path separator is invalid')
assert.equal(isValidId('.hidden'), false, 'a leading dot is invalid')
assert.equal(isValidId('x'.repeat(65)), false, 'an over-long id is invalid')

// --- matching ------------------------------------------------------------

assert.equal(matchesModel('deepseek-v4.1-flash', ['deepseek-v4.1-flash']), true, 'exact match')
assert.equal(matchesModel('deepseek-v4.1-flash', ['deepseek-v4.1']), false, 'a prefix is not an exact match')
assert.equal(matchesModel('deepseek-v4.1-flash', ['deepseek-*']), true, 'a trailing wildcard matches')
assert.equal(matchesModel('minimax-cn/MiniMax-M3.1-Flash', ['minimax-cn/*']), true, 'a path wildcard matches')
assert.equal(matchesModel('minimax-cn/MiniMax-M3.1-Flash', ['*']), true, 'the catch-all matches')
assert.equal(matchesModel('deepseek-v4.1-flash', ['DEEPSEEK-V4.1-FLASH']), true, 'matching is case-insensitive')
assert.equal(matchesModel('', ['*']), false, 'an empty model matches nothing')
assert.equal(matchesModel('deepseek-v4.1-flash', []), false, 'no pattern matches nothing')

// --- selection precedence ------------------------------------------------

const profiles = [
  { id: 'all', name: 'All', models: ['*'], enabled: true },
  { id: 'dsh', name: 'DeepSeek', models: ['deepseek-*'], enabled: true },
  { id: 'exact', name: 'Exact', models: ['deepseek-v4.1-flash'], enabled: true },
  { id: 'off', name: 'Disabled', models: ['deepseek-v4.1-flash'], enabled: false },
]

assert.equal(selectProfile(profiles, 'deepseek-v4.1-flash')?.id, 'exact', 'an exact id beats a wildcard')
assert.equal(selectProfile(profiles, 'deepseek-v4.2-pro')?.id, 'dsh', 'a longer wildcard beats the catch-all')
assert.equal(selectProfile(profiles, 'gpt-4o')?.id, 'all', 'the catch-all takes anything else')
assert.equal(selectProfile(profiles, 'unknown-model')?.id, 'all', 'the catch-all applies to unmatched models')
assert.equal(
  selectProfile([{ id: 'off', name: 'Off', models: ['*'], enabled: false }], 'anything'),
  null,
  'a disabled profile never applies',
)

// --- the provider route is a separate name ------------------------------
//
// The Harness keeps the route and the model id apart: an agent's options
// carry `model: "MiniMax-M3.1-Flash"` and `provider: "minimax-cn"`. A
// pattern may therefore name the model, the route, or the two joined.

assert.equal(
  selectProfile(profiles, 'MiniMax-M3.1-Flash', 'minimax-cn')?.id,
  'all',
  'the catch-all still applies when a provider is given',
)
assert.equal(
  selectProfile(
    [{ id: 'route', name: 'Route', models: ['minimax-cn/*'], enabled: true }],
    'MiniMax-M3.1-Flash',
    'minimax-cn',
  )?.id,
  'route',
  'a route-qualified pattern matches a bare model id',
)
assert.equal(
  selectProfile(
    [{ id: 'bare', name: 'Bare', models: ['MiniMax-M3.1-Flash'], enabled: true }],
    'MiniMax-M3.1-Flash',
    'minimax-cn',
  )?.id,
  'bare',
  'a bare model id pattern matches when a provider is given',
)
assert.equal(
  selectProfile(
    [{ id: 'route', name: 'Route', models: ['minimax-cn'], enabled: true }],
    'MiniMax-M3.1-Flash',
    'minimax-cn',
  )?.id,
  'route',
  'a pattern may name the provider route on its own',
)
assert.equal(
  selectProfile(
    [{ id: 'other', name: 'Other', models: ['openai/*'], enabled: true }],
    'MiniMax-M3.1-Flash',
    'minimax-cn',
  ),
  null,
  'a pattern for another route does not match',
)

// --- store round trip ----------------------------------------------------

const store = new RuleStore(dir)
await store.upsert(
  { id: 'first', name: 'First', models: ['deepseek-*'], enabled: true, description: 'a note' },
  'The body for {{model}} on {{provider}}.\n',
)
await store.upsert({ id: 'second', name: 'Second', models: ['*'], enabled: true }, 'Catch-all body.\n')

const reloaded = new RuleStore(dir)
const loaded = await reloaded.load()
assert.equal(loaded.length, 2, 'both profiles load from disk')
assert.equal(reloaded.text('first'), 'The body for {{model}} on {{provider}}.\n', 'the body round-trips')
assert.deepEqual(
  loaded.find((profile) => profile.id === 'first').models,
  ['deepseek-*'],
  'the model patterns round-trip',
)
assert.equal(loaded.find((profile) => profile.id === 'first').description, 'a note', 'the description round-trips')

// The index on disk is machine-readable on its own.
const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'))
assert.equal(index.version, 1, 'the index declares its version')
assert.equal(index.profiles.length, 2, 'the index lists both profiles')

// --- a malformed index is not fatal --------------------------------------

const broken = new RuleStore(join(dir, 'broken'))
await mkdir(join(dir, 'broken'), { recursive: true })
await writeFile(join(dir, 'broken', 'index.json'), '{ not json', 'utf8')
assert.deepEqual(await broken.load(), [], 'a broken index yields an empty store instead of throwing')

// --- deleting a profile removes its file ---------------------------------

await store.remove('first')
assert.equal(store.profiles.length, 1, 'the profile is gone from the index')
await assert.rejects(() => readFile(join(dir, 'profiles', 'first.md'), 'utf8'), 'the profile file is gone')

console.log('rules.test.mjs: all checks passed')
