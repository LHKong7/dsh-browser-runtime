# dsh-browser-runtime

English | [中文](README.zh.md)

`dsh-browser-runtime` gives each DeepSeek Harness Agent a leased, stateful browser environment. It owns provider selection, Agent isolation, lifecycle, serialized operations, stale-reference checks, checkpoint indexing, and transition evidence. Playwright is one provider behind that API, and the model tools are a separate consumer.

This repository is one installable DSH bundle with three plugin entry points:

| Entry point | Role | Service or tools |
|---|---|---|
| `dsh-browser-runtime` | Service Definition and control plane | `ctx.browserRuntime` |
| `dsh-browser-runtime/playwright` | Playwright/Chromium Provider | provider id `playwright` |
| `dsh-browser-runtime/tools` | Model-facing Consumer | five `browser_*` tools |

The single-package layout supports `dsh plugin add github:...`. The source directories preserve the three roles so they can become separate npm packages if their release cycles diverge.

## v0.1 behavior

- One isolated BrowserContext and one Page per exact Agent object.
- Concurrent acquisition by the same owner shares setup and returns independent leases; different owners never share an environment.
- Operations for one environment run FIFO; separate environments may run concurrently.
- Each observation mints local refs such as `e1`. Only refs from the latest observation are accepted.
- `navigate`, `click`, and `fill` produce before/after transition evidence. Fill values are redacted from runtime evidence.
- Screenshots are PNG attachments through `ctx.attachments`; the model cannot choose a host path.
- `resume` checkpoints cookies and localStorage. A restore creates a new generation, invalidating every prior page, observation, and element identity.
- Last-lease release, Agent disposal, provider unload, and runtime unload all await browser cleanup.

The model tools are:

| Tool | Purpose |
|---|---|
| `browser_open` | Navigate to an HTTP(S) URL and return an observation |
| `browser_observe` | Refresh page text and interactive element refs |
| `browser_click` | Click a ref from the latest observation |
| `browser_fill` | Fill a non-password ref with non-secret text |
| `browser_screenshot` | Save a viewport or full-page PNG attachment |

## Develop and test

Prerequisites are Node.js `^22.19` or `>=24` and pnpm 10.

```sh
pnpm install
pnpm exec playwright install chromium
pnpm run typecheck
pnpm test
pnpm run build
pnpm pack
```

`pnpm test` uses a real local HTTP server and Chromium when Playwright's managed browser is present. The Playwright suite self-skips when Chromium is absent; CI installs it explicitly.

## Install into DeepSeek Harness

For a local checkout, build a tarball and install it into a profile:

```sh
pnpm install
pnpm exec playwright install chromium
pnpm pack
dsh plugin --profile browser add ./dsh-browser-runtime-0.1.0.tgz
dsh plugin --profile browser exec playwright install chromium
dsh --profile browser --dump-config
```

For a GitHub installation, pin a commit:

```sh
dsh plugin --profile browser add github:YOUR_ACCOUNT/dsh-browser-runtime#COMMIT_SHA
dsh plugin --profile browser exec playwright install chromium
```

Git installs run the package's `prepare` build. pnpm 10 rejects that script until the profile's `pnpm-workspace.yaml` allows the exact package:

```yaml
allowBuilds:
  dsh-browser-runtime: true
```

Review and pin the source before granting build permission. A published npm package or the tarball path ships built artifacts and does not need that permission.

## Configuration

The bundle's [`cordis.patch.yml`](cordis.patch.yml) selects Playwright, uses ephemeral Agent environments, blocks private networks, and registers all five tools. A user profile can replace any row by id; DSH patches replace the complete `config`, so restate every field for that row.

Runtime row:

```yaml
- id: browser-runtime
  config:
    provider: playwright
    maxTextChars: 60000
    maxTransitionsInMemory: 500
    cleanupTimeoutMs: 10000
```

Playwright row:

```yaml
- id: browser-playwright
  config:
    headless: true
    navigationTimeoutMs: 30000
    actionTimeoutMs: 10000
    maxElements: 100
    allowPrivateNetwork: false
    # executablePath: /absolute/path/to/chromium
    # checkpointRoot: /private/absolute/path
```

Tool row:

```yaml
- id: tool-browser
  config:
    provider: playwright
    persistence: ephemeral # or resume
    timeoutMs: 30000
```

With `persistence: resume`, checkpoints restore inside the same process from the runtime's in-memory index. Cross-process restore additionally requires DSH's `ctx.storageDomain`; the Web profile already mounts it. Checkpoint metadata goes to the `browser_runtime` domain, while Playwright stores the sensitive storage-state payload under `$DSH_HOME/browser-runtime/providers/playwright/v1/checkpoints` with owner-only permissions.

## Security limits

The default provider uses a temporary isolated browser profile, a private scrubbed `HOME`, blocked service workers, no download or upload API, no arbitrary model-supplied JavaScript, no model-supplied selectors, and no connection to the user's Chrome profile. Navigation accepts only HTTP(S) URLs without embedded credentials. DNS-resolved loopback, private, link-local, reserved, and multicast addresses are rejected unless `allowPrivateNetwork` is explicitly enabled.

`browser_fill` is not a secret-entry channel. DSH logs raw tool-call arguments before this plugin runs, so secrets in the `value` argument remain in the Session log even though transition evidence redacts the value. Password inputs are rejected.

The DNS check does not prove protection against DNS rebinding after resolution. Treat the provider as application-layer SSRF reduction, not a network sandbox; use host firewall or container policy for a hard boundary.

## Limits

v0.1 has one page, no popup handoff, downloads, uploads, arbitrary JavaScript, real-Chrome attachment, cross-provider checkpoint conversion, IndexedDB/sessionStorage restore, credential management, or generic non-browser Environment API. Playwright-managed Chromium must be installed separately.

See [architecture and provider API](docs/architecture.md) for ownership, failure, evidence, and extension rules.
