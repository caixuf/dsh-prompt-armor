/**
 * dsh-prompt-armor — Host half.
 *
 * Injects a per-model prompt into every agent's system prompt through the
 * official `ctx.systemPrompt.section()` seam. No file inside `@deepseek-ai/*`
 * is touched, so the plugin survives Harness upgrades: upstream projects that
 * rewrite core packages to inject a prompt have to re-match their patch
 * against every new release, and stop working when the strings move.
 *
 * How the dispatch works:
 *   - one prompt section is registered at a configurable order;
 *   - its `text` is a function, evaluated at every prompt assembly;
 *   - the function reads the current model from `context.agent.options.model`
 *     and returns the body of the profile whose patterns match.
 *
 * When nothing matches, the section renders empty and the Harness drops it,
 * so an empty rule set leaves the system prompt exactly as it was.
 *
 * @module dsh-prompt-armor
 */

import z from '@deepseek-ai/schemastery'
import { RuleStore, selectProfile } from './lib/rules.js'
import { registerApi } from './lib/api.js'

/** Cordis plugin name. */
export const name = 'dsh-prompt-armor'

/** Services this half needs. */
export const inject = ['systemPrompt']

/**
 * Plugin config.
 *
 * Every field survives a Harness upgrade because it lives in the user's patch
 * layer, and the order is a plain number rather than a dependency on a named
 * slot that a future release may renumber.
 */
export const Config = z.object({
  /**
   * Whether the plugin contributes a prompt section at all. Turning this off
   * leaves the system prompt exactly as the Harness built it.
   */
  enabled: z.boolean().default(true),

  /**
   * Where the profiles live. Defaults to the plugin's own directory under the
   * Harness home, so profiles follow the profile that owns them.
   */
  dataDir: z.string().default(''),

  /**
   * Order of the injected section.
   *
   * The default puts the injected text first, ahead of the Harness' own
   * identity line, which is where an operator persona has to sit for it to
   * read as the frame rather than as an aside. A value above 10200 places it
   * after the deployment persona suffix instead, which reads as a trailing
   * instruction.
   */
  order: z.number().default(-100000),

  /**
   * Whether the section is preceded by a heading naming the profile it came
   * from, so the model can tell which rule set is in force.
   */
  showProfileName: z.boolean().default(true),
})

/**
 * Resolve the profile store's directory.
 *
 * The Harness exposes `dshHomePath()` to Loader config expressions, so the
 * default normally arrives already resolved from the patch. The fallback
 * covers a host started without that expression.
 *
 * @param {string} configured - the configured directory.
 * @returns {string} the directory to use.
 */
function resolveDataDir(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const home = process.env.DSH_HOME
  const base = home && home.trim() !== '' ? home.trim() : `${process.env.HOME ?? ''}/.dsh`
  return `${base}/prompt-armor`
}

/**
 * Substitute the two variables a profile may reference.
 *
 * The Harness resolves `{{...}}` against its own variable registry and throws
 * on an unknown reference, so a profile containing a literal `{{` would break
 * prompt assembly. This section is registered with `interpolate: false` for
 * that reason, which also means the Harness performs no substitution — so the
 * two useful variables are resolved here instead, and anything else is left
 * exactly as the author wrote it.
 *
 * @param {string} text - the profile body.
 * @param {string} model - the current model id.
 * @param {string} provider - the current provider route.
 * @returns {string} the text with the known variables replaced.
 */
function substitute(text, model, provider) {
  return text
    .replace(/\{\{model\}\}/g, model)
    .replace(/\{\{provider\}\}/g, provider)
}

/**
 * Mount the host half.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {RuleStore} store - the rule store.
 * @param {object} config - the resolved plugin config.
 */
function mount(ctx, store, config) {
  if (!config.enabled) return

  /**
   * Choose the prompt text for the agent the assembly is for.
   *
   * The section's `text` is evaluated synchronously at assembly time, so this
   * reads the store's in-memory snapshot rather than awaiting a load.
   *
   * @param {any} context - the assembly context; `agent` carries the model.
   * @returns {string} the prompt text, empty when no profile applies.
   */
  const resolveText = (context) => {
    // A user may edit the rule files in a text editor while an agent is
    // running; notice that change so the next step sees it.
    store.refreshIfChanged()
    const agent = context?.agent
    const model = agent?.options?.model
    if (typeof model !== 'string' || model === '') return ''
    const provider = typeof agent?.options?.provider === 'string' ? agent.options.provider : ''
    const profile = selectProfile(store.profiles, model, provider)
    if (profile === null) return ''
    const body = store.text(profile.id)
    if (body.trim() === '') return ''
    const text = substitute(body, model, provider)
    if (!config.showProfileName) return text
    return `## ${profile.name}\n\n${text}`
  }

  ctx.effect(
    () => ctx.systemPrompt.section({
      name: 'dsh-prompt-armor:profile',
      order: config.order,
      // The body is user prose: it may legitimately contain `{{...}}`, and
      // interpolated sections throw on an unknown variable reference. The
      // Harness' own tool SDK section does the same for the same reason.
      interpolate: false,
      text: resolveText,
    }),
    'prompt-armor.section()',
  )
}

/**
 * Entry point for the Host half.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {typeof Config} config - the plugin config.
 */
export function apply(ctx, config) {
  const store = new RuleStore(resolveDataDir(config.dataDir))

  // The section is registered during `apply`, not from an asynchronous effect:
  // a section that only appears once a promise settles is a section that can
  // be missing from the first prompt the host assembles. The rules themselves
  // are read lazily at assembly time, so an empty or unreadable rule
  // directory costs nothing and breaks nothing.
  mount(ctx, store, config)

  // Warm the cache in the background so the first assembly does not pay for
  // the read.
  void store.ensureLoaded()

  // The most recent agent, so the panel can show the prompt the model
  // actually receives rather than a reconstruction of it.
  let lastAgent = null
  ctx.on('agent/created', (payload) => {
    if (payload?.agent !== undefined) lastAgent = payload.agent
  })

  // Expose the store so a companion panel or an agent tool can reach it
  // without re-reading the files.
  ctx.provide('promptArmor', {
    store,
    /**
     * The profile that applies to a model id.
     *
     * @param {string} model - the model id.
     * @param {string} [provider] - the provider route.
     * @returns {Promise<object | null>} the matching profile.
     */
    async profileFor(model, provider = '') {
      const profiles = await store.ensureLoaded()
      const profile = selectProfile(profiles, model, provider)
      return profile === null ? null : { ...profile, text: store.text(profile.id) }
    },
    /**
     * The prompt sections the live host assembles for the current agent.
     *
     * @returns {Promise<object | null>} the assembly, or null before any
     *   agent exists.
     */
    async livePrompt() {
      // The plugin may have been installed after the running agent was
      // created, so the registry is consulted as well as the event.
      let agent = lastAgent
      if (agent === null) {
        const agents = ctx.get('agents')
        const list = typeof agents?.list === 'function' ? agents.list() : []
        agent = list.length > 0 ? list[list.length - 1] : null
      }
      if (agent === null || agent === undefined) return null
      const assembly = await ctx.systemPrompt.assemble({ scope: agent, agent })
      return {
        model: agent?.options?.model ?? null,
        provider: agent?.options?.provider ?? null,
        sections: assembly.sections.map((section) => ({
          name: section.name,
          text: section.text,
        })),
      }
    },
  })

  // The panel needs a way to read and write the rules. The web server is
  // optional: a host without one still gets the prompt injection, just no
  // editing surface.
  ctx.inject(['webServer'], (inner) => {
    registerApi(inner, store)
  })
}

export default { name, inject, Config, apply }
