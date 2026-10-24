/**
 * The panel's HTTP surface.
 *
 * The Host owns the rules on disk, and the browser half needs to read and
 * write them. A small JSON API over the Harness' own web server is the
 * simplest bridge that needs no new framework: the route lives on the same
 * origin the page is served from, so the browser can reach it with
 * `credentials: 'same-origin'` and no CORS dance.
 *
 * Mutating requests must carry a custom header. A cross-origin page cannot
 * set one without a preflight the Harness never grants, so the header is what
 * makes a CSRF attempt fail before it reaches a mutating handler.
 *
 * @module api
 */

/** The route prefix this plugin owns. */
export const API_PREFIX = '/system-prompt-armor/api'

/** The header a mutating request must carry. */
export const WRITE_HEADER = 'x-dsh-prompt-armor'

/**
 * Send a JSON response.
 *
 * @param {import('node:http').ServerResponse} res - the response object.
 * @param {number} code - the HTTP status code.
 * @param {unknown} body - the payload to serialize.
 */
function sendJson(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * Read the request body as text.
 *
 * @param {import('node:http').IncomingMessage} req - the request object.
 * @param {number} limit - the maximum body size in bytes.
 * @returns {Promise<string>} the body text.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Register the plugin's API route.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - a context with `webServer`.
 * @param {import('./rules.js').RuleStore} store - the rule store.
 */
export function registerApi(ctx, store) {
  const web = ctx.webServer || ctx.get('webServer')
  if (!web || typeof web.register !== 'function') return

  ctx.effect(() => web.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const path = String(req.url || '').split('?')[0]
      const tail = path.replace(/^\/+/, '').split('/').filter(Boolean).pop() || ''
      const method = String(req.method || 'GET').toUpperCase()

      if (method === 'GET') {
        const profiles = await store.ensureLoaded()
        if (tail === 'state' || tail === '') {
          sendJson(res, 200, { ok: true, value: { profiles: store.snapshot() } })
          return
        }
        if (tail === 'match') {
          const model = String(req.headers['x-dsh-model'] || '')
          const provider = String(req.headers['x-dsh-provider'] || '')
          const profile = model === ''
            ? null
            : await ctx.get('promptArmor')?.profileFor(model, provider)
          sendJson(res, 200, { ok: true, value: { model, provider, profile } })
          return
        }
        if (tail === 'prompt') {
          // What the model actually receives, assembled by the live host.
          const live = await ctx.get('promptArmor')?.livePrompt()
          if (live === undefined || live === null) {
            sendJson(res, 404, {
              ok: false,
              error: { code: 'no-agent', message: 'no agent has been created yet' },
            })
            return
          }
          sendJson(res, 200, { ok: true, value: live })
          return
        }
        sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown endpoint: ${tail}` } })
        return
      }

      if (method !== 'POST') {
        sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use GET or POST' } })
        return
      }

      // A mutating request from another origin cannot set a custom header
      // without a preflight, so its absence means the request did not come
      // from this page.
      if (req.headers[WRITE_HEADER] !== '1') {
        sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: `missing ${WRITE_HEADER} header` } })
        return
      }

      let payload = {}
      try {
        const raw = await readBody(req, 4 * 1024 * 1024)
        if (raw.trim() !== '') payload = JSON.parse(raw)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: error.message } })
        return
      }

      try {
        if (tail === 'save') {
          const profiles = await store.upsert({
            id: payload.id,
            name: payload.name,
            models: payload.models,
            enabled: payload.enabled,
            description: payload.description,
          }, typeof payload.text === 'string' ? payload.text : '')
          sendJson(res, 200, { ok: true, value: { profiles } })
          return
        }
        if (tail === 'delete') {
          const profiles = await store.remove(payload.id)
          sendJson(res, 200, { ok: true, value: { profiles } })
          return
        }
        if (tail === 'reorder') {
          const order = Array.isArray(payload.order) ? payload.order : []
          const byId = new Map(store.profiles.map(profile => [profile.id, profile]))
          const next = []
          for (const id of order) {
            const profile = byId.get(id)
            if (profile !== undefined) {
              next.push(profile)
              byId.delete(id)
            }
          }
          for (const profile of byId.values()) next.push(profile)
          store.profiles = next
          await store.save()
          sendJson(res, 200, { ok: true, value: { profiles: store.snapshot() } })
          return
        }
        if (tail === 'reload') {
          const profiles = await store.load()
          sendJson(res, 200, { ok: true, value: { profiles } })
          return
        }
        sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown endpoint: ${tail}` } })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: { code: 'write-failed', message: error.message } })
      }
    },
  }), 'prompt-armor.api()')
}
