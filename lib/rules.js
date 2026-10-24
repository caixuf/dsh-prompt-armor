/**
 * Rule storage: per-model prompt profiles on disk.
 *
 * A profile is a named prompt text plus the model patterns it applies to. The
 * store keeps one JSON index plus one Markdown file per profile, so a user can
 * edit the prose in any editor while the index stays machine-readable.
 *
 * Layout under the plugin's data directory:
 *   index.json        — the ordered profile list and their model patterns
 *   profiles/<id>.md  — one profile's prompt text
 *
 * Every read is defensive: a missing or malformed file yields an empty store
 * rather than an exception, because a broken rule file must never take the
 * agent's prompt down with it.
 *
 * @module rules
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Bumped when the on-disk shape changes in a way older readers cannot parse. */
export const INDEX_VERSION = 1

/** The index file inside the data directory. */
export const INDEX_FILE = 'index.json'

/** The subdirectory holding one Markdown file per profile. */
export const PROFILES_DIR = 'profiles'

/** Longest profile id we accept, so an id can never escape the directory. */
const MAX_ID_LENGTH = 64

/**
 * Check that a profile id is safe to use as a file name.
 *
 * The id becomes a file name under the data directory, so it must not contain
 * path separators, drive letters, or anything else that could address a file
 * outside the profiles directory.
 *
 * @param {unknown} id - the candidate id.
 * @returns {boolean} whether the id is a legal profile id.
 */
export function isValidId(id) {
  return typeof id === 'string'
    && id.length > 0
    && id.length <= MAX_ID_LENGTH
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)
    && !id.includes('..')
}

/**
 * Build the on-disk path of a profile's Markdown file.
 *
 * @param {string} dir - the plugin's data directory.
 * @param {string} id - the profile id.
 * @returns {string} the absolute path of the profile file.
 */
export function profilePath(dir, id) {
  return join(dir, PROFILES_DIR, `${id}.md`)
}

/**
 * A profile as the store holds it.
 *
 * @typedef {object} Profile
 * @property {string} id - stable identifier, also the file name.
 * @property {string} name - human-readable label shown in the panel.
 * @property {string[]} models - model id patterns this profile applies to.
 * @property {boolean} enabled - whether the profile contributes at all.
 * @property {string} [description] - optional note shown in the panel.
 */

/**
 * Normalize one raw index entry into a Profile.
 *
 * @param {unknown} raw - the parsed entry.
 * @returns {Profile | null} the profile, or null when the entry is unusable.
 */
function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return null
  const entry = /** @type {Record<string, unknown>} */ (raw)
  if (!isValidId(entry.id)) return null
  const models = Array.isArray(entry.models)
    ? entry.models.filter(model => typeof model === 'string' && model.trim() !== '').map(model => model.trim())
    : []
  return {
    id: entry.id,
    name: typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : String(entry.id),
    models,
    enabled: entry.enabled !== false,
    ...(typeof entry.description === 'string' && entry.description.trim() !== ''
      ? { description: entry.description.trim() }
      : {}),
  }
}

/**
 * The rule store for one data directory.
 *
 * The store keeps an in-memory copy and writes through to disk on every
 * mutation, so the prompt a running agent sees and the files on disk never
 * disagree for longer than one write.
 */
export class RuleStore {
  /**
   * @param {string} dir - the plugin's data directory.
   */
  constructor(dir) {
    this.dir = dir
    this.indexPath = join(dir, INDEX_FILE)
    this.profilesDir = join(dir, PROFILES_DIR)
    /** @type {Profile[]} */
    this.profiles = []
    /** @type {Map<string, string>} */
    this.texts = new Map()
    /** @type {Promise<unknown> | null} */
    this.loading = null
    /** The index's modification time as last seen, in milliseconds. */
    this.stamp = 0
    /** The wall-clock time of the last change check. */
    this.checkedAt = 0
  }

  /**
   * Reload the rules when the index file changed on disk.
   *
   * The panel writes through this store, but a user may also edit the files
   * in a text editor, and an agent that is already running must see that
   * edit. The check is throttled so a model step costs at most one `stat`
   * per second rather than one per request.
   *
   * The reload is synchronous because the prompt section's `text` function is
   * evaluated synchronously: an asynchronous reload would start after the
   * assembly that noticed the change, so that step would still carry the
   * stale rules.
   *
   * @param {number} [interval] - the minimum gap between checks, in ms.
   * @returns {boolean} whether the rules were reloaded.
   */
  refreshIfChanged(interval = 1000) {
    const now = Date.now()
    if (now - this.checkedAt < interval) return false
    this.checkedAt = now
    let stamp = 0
    try {
      stamp = statSync(this.indexPath).mtimeMs
    } catch {
      // The index is gone; a reload would clear the rules, so leave them be.
      return false
    }
    if (stamp === this.stamp) return false
    this.loadSync()
    return true
  }

  /**
   * Load the index and every profile body from disk, synchronously.
   *
   * @returns {Profile[]} the loaded profiles.
   */
  loadSync() {
    let raw = null
    try {
      raw = JSON.parse(readFileSync(this.indexPath, 'utf8'))
    } catch {
      raw = null
    }
    const list = raw && typeof raw === 'object' && Array.isArray(/** @type {any} */ (raw).profiles)
      ? /** @type {any} */ (raw).profiles
      : []
    const profiles = []
    const texts = new Map()
    for (const entry of list) {
      const profile = normalizeProfile(entry)
      if (profile === null) continue
      profiles.push(profile)
      let body = ''
      try {
        body = readFileSync(profilePath(this.dir, profile.id), 'utf8')
      } catch {
        body = ''
      }
      texts.set(profile.id, body)
    }
    this.profiles = profiles
    this.texts = texts
    try {
      this.stamp = statSync(this.indexPath).mtimeMs
    } catch {
      this.stamp = 0
    }
    return this.profiles
  }

  /**
   * Load the index and every profile body from disk.
   *
   * A missing index is an empty store, not an error: the plugin ships enabled
   * with no rules, and the user adds them from the panel.
   *
   * @returns {Promise<Profile[]>} the loaded profiles.
   */
  async load() {
    let raw = null
    try {
      raw = JSON.parse(await readFile(this.indexPath, 'utf8'))
    } catch {
      raw = null
    }
    const list = raw && typeof raw === 'object' && Array.isArray(/** @type {any} */ (raw).profiles)
      ? /** @type {any} */ (raw).profiles
      : []
    const profiles = []
    for (const entry of list) {
      const profile = normalizeProfile(entry)
      if (profile === null) continue
      profiles.push(profile)
      try {
        this.texts.set(profile.id, await readFile(profilePath(this.dir, profile.id), 'utf8'))
      } catch {
        this.texts.set(profile.id, '')
      }
    }
    this.profiles = profiles
    // Drop the bodies of profiles that no longer exist, so a stale body can
    // never resurface if the same id is recreated later.
    const live = new Set(profiles.map((profile) => profile.id))
    for (const id of [...this.texts.keys()]) {
      if (!live.has(id)) this.texts.delete(id)
    }
    try {
      this.stamp = statSync(this.indexPath).mtimeMs
    } catch {
      this.stamp = 0
    }
    return this.profiles
  }

  /**
   * Load once, sharing one in-flight promise between concurrent callers.
   *
   * @returns {Promise<Profile[]>} the loaded profiles.
   */
  ensureLoaded() {
    if (this.loading === null) {
      this.loading = this.load().catch((error) => {
        console.error('[prompt-armor] cannot load rules:', error)
        return []
      }).finally(() => {
        this.loading = null
      })
    }
    return this.loading
  }

  /**
   * Persist the current index and profile bodies.
   *
   * @returns {Promise<void>} resolves once the files are written.
   */
  async save() {
    await mkdir(this.profilesDir, { recursive: true })
    const index = {
      version: INDEX_VERSION,
      profiles: this.profiles.map(profile => ({
        id: profile.id,
        name: profile.name,
        models: profile.models,
        enabled: profile.enabled,
        ...(profile.description === undefined ? {} : { description: profile.description }),
      })),
    }
    await writeFile(this.indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
    for (const profile of this.profiles) {
      await writeFile(profilePath(this.dir, profile.id), this.texts.get(profile.id) ?? '', 'utf8')
    }
    try {
      this.stamp = statSync(this.indexPath).mtimeMs
    } catch {
      this.stamp = 0
    }
  }

  /**
   * Read one profile's text.
   *
   * @param {string} id - the profile id.
   * @returns {string} the prompt text, or an empty string when unknown.
   */
  text(id) {
    return this.texts.get(id) ?? ''
  }

  /**
   * Add or replace a profile and its body.
   *
   * @param {Profile} profile - the profile to store.
   * @param {string} text - the profile's prompt text.
   * @returns {Promise<Profile[]>} the stored profiles.
   */
  async upsert(profile, text) {
    const normalized = normalizeProfile(profile)
    if (normalized === null) throw new Error('invalid profile id')
    const existing = this.profiles.findIndex(entry => entry.id === normalized.id)
    if (existing >= 0) this.profiles[existing] = normalized
    else this.profiles.push(normalized)
    this.texts.set(normalized.id, text)
    await this.save()
    return this.profiles
  }

  /**
   * Delete a profile and its file.
   *
   * @param {string} id - the profile id.
   * @returns {Promise<Profile[]>} the remaining profiles.
   */
  async remove(id) {
    if (!isValidId(id)) throw new Error('invalid profile id')
    this.profiles = this.profiles.filter(entry => entry.id !== id)
    this.texts.delete(id)
    await this.save()
    try {
      await rm(profilePath(this.dir, id), { force: true })
    } catch {
      /* the file was already gone */
    }
    return this.profiles
  }

  /**
   * Read every profile back as one serializable snapshot.
   *
   * @returns {Array<Profile & { text: string }>} the profiles with their bodies.
   */
  snapshot() {
    return this.profiles.map(profile => ({ ...profile, text: this.text(profile.id) }))
  }
}

/**
 * Decide whether a model id matches a profile's patterns.
 *
 * A pattern is either an exact model id, or a shell-style glob where `*`
 * stands for any run of characters. Matching is case-insensitive because
 * model ids differ only in case between providers.
 *
 * @param {string} model - the current model id.
 * @param {string[]} patterns - the profile's patterns.
 * @returns {boolean} whether any pattern matches.
 */
export function matchesModel(model, patterns) {
  if (typeof model !== 'string' || model === '') return false
  const target = model.toLowerCase()
  return patterns.some((pattern) => {
    const needle = String(pattern).toLowerCase()
    if (!needle.includes('*')) return needle === target
    const escaped = needle.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${escaped}$`).test(target)
  })
}

/**
 * The names a profile's patterns are matched against.
 *
 * The Harness keeps the provider route and the model id apart: an agent's
 * options carry `model: "MiniMax-M3.1-Flash"` and `provider: "minimax-cn"`,
 * not a combined "minimax-cn/MiniMax-M3.1-Flash". A pattern written against
 * the route therefore has to be able to name it, and a pattern written against
 * the model has to keep working, so both forms are offered to the matcher.
 *
 * @param {string} model - the current model id.
 * @param {string} provider - the current provider route.
 * @returns {string[]} the candidate names.
 */
export function candidateNames(model, provider) {
  const names = []
  if (typeof model === 'string' && model !== '') names.push(model)
  if (typeof provider === 'string' && provider !== '') {
    names.push(`${provider}/${model}`)
    names.push(provider)
  }
  return names
}

/**
 * Pick the profile that applies to a model.
 *
 * The most specific match wins: an exact name beats a glob, and a longer
 * glob beats a shorter one. Ties keep the earlier profile in the list, so
 * ordering the panel decides the tie without a hidden rule.
 *
 * Every pattern is tried against every candidate name, so a profile can name
 * the model id, the provider route, or the two joined by a slash.
 *
 * @param {Profile[]} profiles - the store's profiles.
 * @param {string} model - the current model id.
 * @param {string} [provider] - the current provider route.
 * @returns {Profile | null} the winning profile, or null when none applies.
 */
export function selectProfile(profiles, model, provider = '') {
  const names = candidateNames(model, provider)
  let best = null
  let bestScore = -1
  for (const profile of profiles) {
    if (!profile.enabled) continue
    for (const pattern of profile.models) {
      for (const name of names) {
        if (!matchesModel(name, [pattern])) continue
        const score = pattern.includes('*') ? pattern.replace(/\*/g, '').length : pattern.length + 1000
        if (score > bestScore) {
          bestScore = score
          best = profile
        }
      }
    }
  }
  return best
}
