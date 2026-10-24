/**
 * dsh-prompt-armor — browser half.
 *
 * Registers a Settings section where the per-model prompt profiles are listed
 * and edited. The Host owns the files; this half only reads and writes them
 * through the plugin's own JSON route, and renders the result with the
 * Harness' own theme tokens so the panel looks like the rest of the Settings
 * surface rather than a bolted-on page.
 *
 * The browser artifact is plain JavaScript with no build step: the module
 * loader hands it React from the browser module table, and every element is
 * created with `React.createElement`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt-armor',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    /** The route this plugin's Host half serves. */
    const API = '/system-prompt-armor/api'

    /** The header a mutating request must carry; see lib/api.js. */
    const WRITE_HEADER = 'x-dsh-prompt-armor'

    /** Dictionary namespace owned by this plugin. */
    const NS = 'dsh-prompt-armor'

    /**
     * Call the Host's JSON API.
     *
     * @param {string} method - the endpoint tail.
     * @param {object} [payload] - the request body; absent means a read.
     * @returns {Promise<any>} the parsed response value.
     */
    async function api(method, payload) {
      const init = { method: 'GET', credentials: 'same-origin' }
      if (payload !== undefined) {
        init.method = 'POST'
        init.headers = { 'content-type': 'application/json', [WRITE_HEADER]: '1' }
        init.body = JSON.stringify(payload)
      }
      const response = await fetch(`${API}/${method}`, init)
      const parsed = await response.json().catch(() => null)
      if (parsed === null || parsed.ok !== true) {
        const message = parsed?.error?.message ?? `HTTP ${response.status}`
        throw new Error(message)
      }
      return parsed.value
    }

    /**
     * A labelled text input.
     *
     * @param {object} props - the field description.
     * @returns {any} the element tree.
     */
    function Field({ label, value, onChange, placeholder, rows }) {
      return h('label', { style: { display: 'block', marginBottom: '12px' } },
        h('div', {
          style: {
            fontSize: '12px',
            color: 'var(--dsw-alias-label-secondary)',
            marginBottom: '4px',
          },
        }, label),
        h('textarea', {
          value,
          rows,
          placeholder,
          spellCheck: false,
          onChange: (event) => onChange(event.target.value),
          style: {
            width: '100%',
            boxSizing: 'border-box',
            padding: '8px 10px',
            fontSize: '13px',
            fontFamily: rows === undefined ? 'inherit' : 'var(--dsw-alias-font-mono, monospace)',
            lineHeight: 1.5,
            color: 'var(--dsw-alias-label-primary)',
            background: 'var(--dsw-alias-bg-layer-2)',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: '6px',
            resize: 'vertical',
          },
        }))
    }

    /**
     * A primary action button.
     *
     * @param {object} props - the button description.
     * @returns {any} the element tree.
     */
    function Button({ children, onClick, tone, disabled }) {
      const primary = tone !== 'ghost'
      return h('button', {
        type: 'button',
        disabled,
        onClick,
        style: {
          padding: '6px 12px',
          fontSize: '13px',
          borderRadius: '6px',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          border: primary ? 'none' : '1px solid var(--dsw-alias-border-l2)',
          background: primary ? 'var(--dsw-alias-button-primary-fill)' : 'transparent',
          color: primary ? 'var(--dsw-alias-label-primary-inverted)' : 'var(--dsw-alias-label-primary)',
        },
      }, children)
    }

    /**
     * The Settings section: the profile list on the left, the editor on the
     * right.
     *
     * @returns {any} the element tree.
     */
    function ArmorSection() {
      const t = useCallback((key) => ctx.locale.bind(NS)(key), [])
      const [profiles, setProfiles] = useState([])
      const [selectedId, setSelectedId] = useState(null)
      const [draft, setDraft] = useState(null)
      const [status, setStatus] = useState('')
      const [busy, setBusy] = useState(false)

      const refresh = useCallback(async () => {
        try {
          const value = await api('state')
          setProfiles(value.profiles)
          setSelectedId((current) => {
            if (current !== null && value.profiles.some((profile) => profile.id === current)) return current
            return value.profiles.length > 0 ? value.profiles[0].id : null
          })
        } catch (error) {
          setStatus(String(error.message ?? error))
        }
      }, [])

      useEffect(() => {
        void refresh()
      }, [refresh])

      const selected = useMemo(
        () => profiles.find((profile) => profile.id === selectedId) ?? null,
        [profiles, selectedId],
      )

      // Keep the draft in step with the selection, but never overwrite an
      // edit in progress when the list is refreshed from the Host.
      useEffect(() => {
        if (selected === null) {
          setDraft(null)
          return
        }
        setDraft((current) => {
          if (current !== null && current.id === selected.id) return current
          return { ...selected }
        })
      }, [selected])

      const save = useCallback(async () => {
        if (draft === null) return
        setBusy(true)
        setStatus('')
        try {
          const value = await api('save', {
            id: draft.id,
            name: draft.name,
            models: Array.isArray(draft.models)
              ? draft.models
              : String(draft.models ?? '').split(/[\n,]+/).map((entry) => entry.trim()).filter(Boolean),
            enabled: draft.enabled !== false,
            description: draft.description,
            text: draft.text ?? '',
          })
          setProfiles(value.profiles)
          setStatus(t('saved'))
        } catch (error) {
          setStatus(String(error.message ?? error))
        } finally {
          setBusy(false)
        }
      }, [draft, t])

      const remove = useCallback(async () => {
        if (draft === null) return
        setBusy(true)
        setStatus('')
        try {
          const value = await api('delete', { id: draft.id })
          setProfiles(value.profiles)
          setDraft(null)
          setSelectedId(null)
          setStatus(t('deleted'))
        } catch (error) {
          setStatus(String(error.message ?? error))
        } finally {
          setBusy(false)
        }
      }, [draft, t])

      const create = useCallback(() => {
        const id = `profile-${Date.now().toString(36)}`
        const fresh = {
          id,
          name: t('newName'),
          models: ['*'],
          enabled: true,
          text: '',
        }
        setDraft(fresh)
        setSelectedId(id)
      }, [t])

      const listRow = (profile) => h('div', {
        key: profile.id,
        onClick: () => setSelectedId(profile.id),
        style: {
          padding: '6px 8px',
          marginBottom: '2px',
          borderRadius: '6px',
          cursor: 'pointer',
          fontSize: '13px',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          border: profile.id === selectedId
            ? '1px solid var(--dsw-alias-brand-primary)'
            : '1px solid transparent',
          background: profile.id === selectedId
            ? 'var(--dsw-alias-interactive-bg-hover-accent)'
            : 'transparent',
          color: 'var(--dsw-alias-label-primary)',
        },
      },
      h('span', {
        style: {
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          flexShrink: 0,
          background: profile.enabled === false
            ? 'var(--dsw-alias-label-tertiary)'
            : 'var(--dsw-alias-state-success-primary)',
        },
      }),
      h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' } }, profile.name),
      h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' } },
        (profile.models ?? []).join(', ')))

      const listColumn = h('div', { style: { width: '220px', flexShrink: 0 } },
        h('div', { style: { display: 'flex', gap: '6px', marginBottom: '8px' } },
          h(Button, { onClick: create, children: t('new') })),
        profiles.length === 0
          ? h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, t('empty'))
          : h('div', null, profiles.map(listRow)))

      const editor = draft === null
        ? h('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' } }, t('pickOne'))
        : h('div', null,
          h(Field, {
            label: t('name'),
            value: draft.name ?? '',
            onChange: (value) => setDraft({ ...draft, name: value }),
          }),
          h(Field, {
            label: t('models'),
            value: Array.isArray(draft.models) ? draft.models.join('\n') : String(draft.models ?? ''),
            rows: 3,
            placeholder: 'deepseek-v4.1-flash\nminimax-cn/*',
            onChange: (value) => setDraft({
              ...draft,
              models: value.split('\n').map((entry) => entry.trim()).filter(Boolean),
            }),
          }),
          h('div', { style: { marginBottom: '12px' } },
            h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px' } },
              h('input', {
                type: 'checkbox',
                checked: draft.enabled !== false,
                onChange: (event) => setDraft({ ...draft, enabled: event.target.checked }),
              }),
              t('enabled'))),
          h(Field, {
            label: t('text'),
            value: draft.text ?? '',
            rows: 14,
            placeholder: t('textPlaceholder'),
            onChange: (value) => setDraft({ ...draft, text: value }),
          }),
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h(Button, { onClick: save, disabled: busy, children: t('save') }),
            h(Button, { onClick: remove, tone: 'ghost', disabled: busy, children: t('delete') }),
            status === ''
              ? null
              : h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, status)),
          h('div', {
            style: {
              marginTop: '12px',
              fontSize: '12px',
              color: 'var(--dsw-alias-label-tertiary)',
              lineHeight: 1.6,
            },
          }, t('hint')))

      return h('div', { style: { display: 'flex', gap: '16px', alignItems: 'flex-start' } },
        listColumn,
        h('div', { style: { flex: 1, minWidth: 0 } }, editor))
    }

    /**
     * Mount the browser half.
     *
     * @param {any} ctx - the Client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, {
        zh: {
          nav: '模型提示词',
          new: '新建配置',
          newName: '新配置',
          empty: '还没有配置。点「新建配置」开始。',
          pickOne: '在左侧选择一个配置，或新建一个。',
          name: '名称',
          models: '适用模型（每行一个，支持 * 通配）',
          enabled: '启用',
          text: '提示词内容',
          textPlaceholder: '写给这个模型的提示词…\n\n可用变量：{{model}}、{{provider}}',
          save: '保存',
          delete: '删除',
          saved: '已保存',
          deleted: '已删除',
          hint: '提示词按模型匹配后注入到系统提示词。匹配时精确模型 id 优先于通配规则。',
        },
        en: {
          nav: 'Model Prompts',
          new: 'New profile',
          newName: 'New profile',
          empty: 'No profiles yet. Use "New profile" to add one.',
          pickOne: 'Pick a profile on the left, or create a new one.',
          name: 'Name',
          models: 'Applies to (one per line, * wildcards allowed)',
          enabled: 'Enabled',
          text: 'Prompt',
          textPlaceholder: 'The prompt for this model…\n\nAvailable variables: {{model}}, {{provider}}',
          save: 'Save',
          delete: 'Delete',
          saved: 'Saved',
          deleted: 'Deleted',
          hint: 'A profile is injected into the system prompt when the model matches. An exact model id wins over a wildcard.',
        },
      }), 'dsh-prompt-armor: dictionaries')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'prompt-armor',
        order: 48,
        label: () => ctx.locale.bind(NS)('nav'),
        locale: NS,
      }, ArmorSection))
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
