# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@jimiford/webex` — an OpenClaw channel plugin that connects a Cisco Webex bot to OpenClaw. It is published to npm and loaded by OpenClaw's plugin system at runtime; it can also be used standalone (outside OpenClaw) via the exported `WebexChannel` class.

## Commands

```bash
npm run build          # tsc -> dist/
npm run dev             # tsc --watch
npm test                # vitest run (all tests)
npm run test:watch      # vitest watch mode
npm run test:coverage   # vitest run --coverage (90% lines/functions/branches/statements gate, see vitest.config.ts)
```

Run a single test file: `npx vitest run src/send.test.ts`
Run a single test by name: `npx vitest run -t "test name"`

Note: `npm run lint` invokes `eslint`, but eslint is not currently in `devDependencies`/`node_modules` and has no config file in this repo — it will fail until eslint is added.

Tests are colocated with source as `*.test.ts` (e.g. `send.ts` / `send.test.ts`) and run under Node (`vitest.config.ts`, `environment: 'node'`).

## Installing into a real OpenClaw host (for manual testing)

Use the `openclaw` CLI's own plugin installer rather than editing OpenClaw's config by hand:

```bash
npm run build                                                  # dist/ must be current before linking
openclaw plugins install /path/to/openclaw-webex --link        # symlinks this checkout so rebuilds are picked up without reinstalling
# or, to install the published package instead of a local checkout:
openclaw plugins install @jimiford/webex
```

After installing, verify registration without starting the whole gateway:

```bash
openclaw plugins inspect webex --runtime --json   # look for "status": "loaded" and "httpRoutes": 1
openclaw plugins doctor                            # should report "No plugin issues detected."
```

Both of the checks above will surface plugin-loading regressions (e.g. calling a removed SDK method, missing manifest metadata) that `npm test`/`tsc` cannot catch, since this repo's `openclaw/plugin-sdk` types are hand-maintained stubs (see [`openclaw-types.d.ts`](#openclaw-typesdts) below), not the real SDK — `tsc` will happily compile against a stubbed method that no longer exists at runtime. Treat a clean `openclaw plugins install --link` + `doctor` as required verification for any change touching `plugin.ts` or `openclaw.plugin.json`, not just green tests.

Once loaded, actually receiving/sending Webex traffic requires configuring `channels.webex` (token, webhookUrl, dmPolicy, ...) in OpenClaw's config and restarting the gateway.

**The live gateway is a long-running daemon that does not hot-reload plugin code.** `openclaw plugins install --link` and config edits (`openclaw config set` / hand-editing `~/.openclaw/openclaw.json`) only take effect on the *next* gateway start. If you change anything in `plugin.ts`, `channel-plugin.ts`, or `openclaw.plugin.json`, you must `npm run build` and then `openclaw gateway restart` before it's live — otherwise you'll be debugging against stale in-memory code while every fresh CLI invocation (`plugins doctor`, `plugins inspect --runtime`, `config validate`) reports clean, because those spawn a new process each time and read current disk state. This gap cost real time once (see Changelog).

## Architecture

The package exposes **two parallel integration surfaces** for the same underlying Webex logic — don't confuse them when making changes:

1. **`channel-plugin.ts` (`webexPlugin`)** — the real OpenClaw integration. This is a `ChannelPlugin` object (config resolution, DM policy, outbound send, gateway lifecycle, status probing) registered with OpenClaw core. `plugin.ts`'s default-exported `register(api)` function is the actual entry point OpenClaw loads (declared in `package.json` under `openclaw.extensions` and mirrored in `openclaw.plugin.json`'s `dist/plugin.js`). This is what runs in production.
2. **`channel.ts` (`WebexChannel`)** — a standalone, framework-agnostic wrapper (`initialize`/`send`/`onMessage`/`handleWebhook`) for using this package directly without the OpenClaw plugin host, documented in the README's usage examples. It duplicates some of what `channel-plugin.ts` does but talks to `WebexSender`/`WebexWebhookHandler` directly instead of going through OpenClaw's dispatch pipeline.

Both surfaces sit on top of the same two low-level modules:

- **`send.ts` (`WebexSender`)** — thin Webex REST client. Resolves a `to` target into `roomId` / `toPersonId` / `toPersonEmail` (email if it contains `@`, else base64-decodes Webex IDs prefixed `Y2lzY29zcGFyazovL3` to distinguish `/ROOM/` vs `/PEOPLE/`, defaulting to `roomId`). Handles retries with exponential backoff + jitter (capped at 30s) on `429/502/503/504` and common network errors.
- **`webhook.ts` (`WebexWebhookHandler`)** — verifies `x-spark-signature` (HMAC-SHA1) when a `webhookSecret` is configured, drops the bot's own messages, enforces `dmPolicy` (`allow`/`deny`/`allowlisted` by person ID or email) for direct messages, fetches full message content (webhooks only carry IDs), and normalizes Webex messages into the `OpenClawEnvelope` shape. Also owns webhook (de)registration against the Webex API.

  `normalizeMessage` strips a leading @mention of the bot from `content.text` (`stripBotMention`). This matters because Webex only delivers group-room messages that mention the bot, and it renders that mention *as plain text* in the message's `text` field — `@Bot /new` arrives as `"Bot /new"`. Since `channel-plugin.ts` feeds `content.text` straight into `Body`/`RawBody`/`CommandBody`, an unstripped prefix hides the leading `/` from OpenClaw's command parser, so slash commands work in DMs (no mention) but silently fall through to the agent in group rooms. The mention's rendered name is read out of the message's `html` (`<spark-mention data-object-id=…>`) so the stripped string is known exactly; `displayName`/`nickName` from `people/me` are a fallback for messages without usable HTML. Only a leading mention of *this* bot is stripped; the untouched original stays at `metadata.raw.text`.

### Multi-account config resolution (`channel-plugin.ts`)

`channels.webex` in OpenClaw's core config can define a single top-level account and/or a `channels.webex.accounts` map of named accounts. `resolveWebexAccount`/`listWebexAccountIds` merge named-account fields over the top-level section (named account values win, falling back to the section's). `DEFAULT_ACCOUNT_ID = "default"` is the implicit account when none is named.

### Webhook HTTP routing (`channel-plugin.ts`)

`createWebhookHandler()` returns a raw Node `(req, res)` handler matched against paths of the form `/webhooks/webex/{accountId}`, looked up in the module-level `webhookTargets` map populated by `registerWebexWebhookTarget` when an account starts (`gateway.startAccount`). On a valid inbound message it builds a context payload and calls into OpenClaw's reply pipeline via `runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher` — accessed through an `as any` cast because that method isn't declared in this repo's local `openclaw/plugin-sdk` type stubs (see below).

### `openclaw-types.d.ts`

Ambient, hand-maintained type stubs for the external `openclaw/plugin-sdk` module (this repo doesn't vendor the real SDK types). They are intentionally minimal and **do not cover the full runtime surface** — `channel-plugin.ts` reaches for functionality beyond these stubs (e.g. `runtime.config.loadConfig`, `runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher`) via `as any` casts. When adding new runtime calls, expect to either extend this stub file or cast.

Because these are hand-maintained rather than generated/vendored, `tsc`/`vitest` staying green does **not** mean the real OpenClaw runtime will accept the plugin — a stubbed method can happily typecheck against calls to an API that no longer exists at runtime (this happened; see Changelog). Verify against a real host per the installing section above for anything touching `OpenClawPluginApi`.

### `openclaw.plugin.json`: two independent config schemas, two different storage locations

The manifest has both a **top-level `configSchema`** and a **`channelConfigs.webex.schema`**, and they are not interchangeable:

- Top-level `configSchema` is *generic plugin config*. Values entered against it are stored at `plugins.entries.webex.config` in OpenClaw's core config. It's required by the manifest loader (`"plugin manifest requires configSchema"` if omitted), but this plugin has no config that isn't channel-account-scoped, so it's kept as an empty schema (`{ type: "object", additionalProperties: false, properties: {} }`) — deliberately, to make it structurally impossible for setup flows to write account fields there.
- `channelConfigs.webex.schema` is *channel-account config*. Values entered against it belong at `channels.webex` (or `channels.webex.accounts.<id>`), which is what `channel-plugin.ts`'s `resolveWebexAccount()` / `listWebexAccountIds()` actually read.

Previously both schemas declared the same fields (`token`, `webhookUrl`, `dmPolicy`, ...), and an install/setup flow wrote real config into the generic `plugins.entries.webex.config` location — where the plugin's own code never looks. `channels.webex.token` was empty, so `listWebexAccountIds()` returned `[]` and the channel was silently never started, even though `plugins.entries.webex.enabled` was `true` and nothing in the plugin's own logs said so. If you ever see `channels.webex` behaving as if it has no account, check `plugins.entries.webex.config` for stray duplicate values before assuming the code is broken.

`WebexChannelConfig`/`DmPolicy` in `types.ts` describe the same account config from the TS side and can drift from the JSON schema — `DmPolicy` in `types.ts` includes both `'allowlisted'` and `'allowlist'` as valid values, while the JSON schema and `channel-plugin.ts` only accept `'allowlisted'` (normalized to OpenClaw's own `'allowlist'` at the `security.resolveDmPolicy` boundary). Keep these in sync when changing DM policy handling.

### `gateway.startAccount` must not resolve until the account stops

OpenClaw's gateway account supervisor `await`s the promise returned by `startAccount(ctx)`. **Any** resolution of that promise — success or failure — is treated as "the channel exited," logged as `"channel exited without an error"`, and triggers an auto-restart loop (backoff up to `MAX_RESTART_ATTEMPTS`). The framework never captures or calls a value `startAccount` returns; a returned cleanup closure is silently discarded.

The correct pattern (used in `gateway.startAccount` today): do one-time setup (register webhooks, register the HTTP route), then `await` on `ctx.abortSignal` firing before returning, running cleanup only once the signal fires:

```ts
await new Promise<void>((resolve) => {
  if (abortSignal?.aborted) { resolve(); return; }
  abortSignal?.addEventListener("abort", () => resolve(), { once: true });
});
// cleanup here
```

If this account ever appears to "start" successfully in logs but then keeps restarting every few seconds/minutes, this contract is almost certainly what's violated — check for an early `return` out of `startAccount` before the abort-signal wait.

### Entry points

- `index.ts` — the npm package's public API surface (re-exports both integration surfaces, all types, and error classes) for consumers who `import` this package directly.
- `plugin.ts` — the OpenClaw plugin loader entry point (referenced by `package.json`'s `openclaw.extensions` and `openclaw.plugin.json`).

## Changelog (fixes made against a real OpenClaw 2026.6.11 host)

This plugin was written against an aspirational/older version of the OpenClaw plugin SDK. `npm run build` and `npm test` were green the whole time; none of the following were caught until installing (`openclaw plugins install --link`) against a real, running OpenClaw host. All three were required together to get the channel actually receiving Webex messages — fixing only one still left it broken.

1. **`api.registerHttpHandler` doesn't exist anymore.** `plugin.ts` called a removed SDK method (`TypeError: api.registerHttpHandler is not a function`, plugin failed to register at all). Replaced with the current API, `api.registerHttpRoute({ path: "/webhooks/webex", match: "prefix", auth: "plugin", handler })`, confirmed against OpenClaw's own bundled `extensions/webhooks` plugin as the reference pattern. Also updated the local `openclaw-types.d.ts` stub (added `registerHttpRoute`, removed `registerHttpHandler`) and the mock `api` object in `index.test.ts`.
2. **Manifest was missing `channelConfigs`, causing config to land in the wrong place.** `openclaw plugins doctor` warned about missing `channelConfigs` metadata. Root-caused to the plugin-level vs. channel-level config split described above — fixed by emptying the top-level `configSchema` and keeping the account fields only in `channelConfigs.webex`, then migrating stray values that had accumulated at `plugins.entries.webex.config` into `channels.webex` by hand.
3. **`gateway.startAccount` returned instead of staying pending**, so the account supervisor treated every successful start as a crash and auto-restarted it in a loop (`"channel exited without an error"`, escalating backoff). Fixed by awaiting `ctx.abortSignal` before returning, per the contract described above.

Each fix required `npm run build` + `openclaw gateway restart` to actually take effect — the running gateway process doesn't pick up rebuilt plugin code or manifest changes on its own.
