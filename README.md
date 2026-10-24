# dsh-prompt-armor

Give each model its own system prompt in DeepSeek Harness.

A **profile** is a named prompt plus the model patterns it applies to. When an
agent assembles its system prompt, the profile that matches the current model
is injected. Different models therefore get different instructions, from the
same harness, with no restart and no core-file patching.

## Why this exists

The community plugin `dsh-purge` does the same job — inject a prompt into
every model — by rewriting the files inside `@deepseek-ai/*` with a 355 KB
table of string replacements. That approach has three consequences:

- **It is version-fragile.** The table matches literal source strings, so a
  Harness release that moves a space silently breaks the plugin. The table
  needs a new branch for every release.
- **It is undone by the package manager.** The patches live in
  `node_modules`, so a reinstall wipes them and the plugin has to re-patch on
  the next start.
- **It has to guess.** The official workspace baseline is a user message, not
  a prompt section, so the plugin's "drop the baseline" filter matches by
  name and text and usually does not fire.

This plugin uses the official seam instead. The Harness exposes
`ctx.systemPrompt.section()` for exactly this purpose, and the harness itself
uses it for every tool's guidance text. The section is registered on the
plugin's own context, so unloading the plugin removes it and the system
prompt returns to its default shape.

It also implements a thing `dsh-purge` only advertises: **per-model
dispatch**. The upstream README says "swap prompts per model", but its code
has no model, provider, or route key anywhere — the prompt it injects is the
same for every model. Here the model id is read from the assembly context,
so the dispatch is real.

## Install

```sh
dsh plugin --profile desktop add <path-to-this-directory>
```

Or, in the desktop client, use **Settings → Plugins**, and enter the
directory in the install box.

## Use

Open **Settings → Model Prompts**. The panel lists the profiles on the left
and edits the selected one on the right.

| Field | Meaning |
| --- | --- |
| Name | The label shown in the panel and, optionally, above the injected text. |
| Applies to | Model patterns, one per line. `*` is a wildcard. |
| Enabled | Whether the profile contributes at all. |
| Prompt | The text injected into the system prompt. |

Two variables are substituted in the prompt body: `{{model}}` and
`{{provider}}`. Any other `{{…}}` is left exactly as written.

### Matching

The most specific pattern wins:

- an exact model id beats a wildcard;
- a longer wildcard beats a shorter one;
- a disabled profile never applies;
- with no match, nothing is injected and the system prompt is unchanged.

So a profile listing `deepseek-v4.1-flash` applies to that model only, while
a profile listing `deepseek-*` applies to every DeepSeek model, and a
profile listing `*` is the catch-all.

### Files

The Host owns the rules on disk, under `$DSH_HOME/prompt-armor/`:

```
index.json          the profile list and their model patterns
profiles/<id>.md    one profile's prompt text
```

The panel writes through the Host, but the files are ordinary text: edit them
in any editor and a running agent picks the change up on its next step.

## Configuration

The plugin's row in `cordis.patch.yml` accepts:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Whether the plugin contributes a section at all. |
| `dataDir` | `$DSH_HOME/prompt-armor` | Where the profiles live. |
| `order` | `-100000` | Where the injected text sits in the prompt. |
| `showProfileName` | `true` | Whether the profile name heads the injected text. |

`order` is a plain number, so it does not depend on a named slot that a
future release may renumber. The default puts the injected text first, ahead
of the harness' own identity line, so a persona reads as the frame rather
than as an aside. A value above `10200` places it after the deployment
persona suffix instead, where it reads as a trailing instruction.

## How it works

The Host half registers one prompt section:

```js
ctx.systemPrompt.section({
  name: 'dsh-prompt-armor:profile',
  order: config.order,
  interpolate: false,
  text: (context) => {
    const model = context.agent?.options?.model
    const profile = selectProfile(store.profiles, model)
    return profile === null ? '' : store.text(profile.id)
  },
})
```

`text` is a function, so it is evaluated at every prompt assembly and can
read the model the assembly is for. The section is registered with
`interpolate: false`, because a user prompt may legitimately contain `{{…}}`
and the harness throws on an unknown variable reference.

The browser half is plain JavaScript with no build step: it registers a
`settings.section` entry and talks to the Host over a small JSON route on
the harness' own web server. Mutating requests carry a custom header, so a
cross-origin page cannot drive them.

## Tests

```sh
node test/rules.test.mjs       # the matcher and the store
DSH_ASAR=<resources>/app.asar node test/integration.test.mjs
```

The integration test extracts the installed `@deepseek-ai/dsh-system-prompt`
from the desktop `app.asar`, mounts the Host half on the real registry, and
asserts the assembled prompt — so "the injected text reaches the model" is
checked against the harness that is actually installed.

## Licence

MIT.
