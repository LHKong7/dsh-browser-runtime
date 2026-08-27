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
- Cancelling one acquire or tool call stops only that caller's wait; another waiter can finish the shared owner setup.
- Cancelling an active browser operation releases the possibly unusable Agent lease; the next tool call opens or restores a fresh environment.
- Operations for one environment run FIFO; separate environments may run concurrently.
- Each observation mints local refs such as `e1`. Only refs from the latest observation are accepted.
- `navigate`, `click`, and `fill` produce before/after transition evidence. Fill values are redacted from runtime evidence.
- A compact transition-index write failure warns the operator without changing action success, Provider failure, or cancellation; current-process queries retain the bounded in-memory record.
- Screenshots are PNG attachments through `ctx.attachments`; the model cannot choose a host path.
- `resume` checkpoints cookies and localStorage. A restore creates a new generation, invalidating every prior page, observation, and element identity. Checkpoint payload creation, index commit or rollback, and old-payload cleanup serialize per session across owner objects; one Provider cannot replace another Provider's session checkpoint.
- Provider unload aborts and waits selection/opening before provider-wide disposal; last-lease release, Agent disposal, and runtime unload also await browser cleanup.

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
pnpm run test:coverage
pnpm run build
pnpm run lint:package
pnpm pack
```

`pnpm test` uses a real local HTTP server and Chromium when Playwright's managed browser is present. The Playwright suite self-skips when Chromium is absent; CI installs it explicitly.

## Install into DeepSeek Harness

For a local checkout, build a tarball and install it into a profile:

```sh
pnpm install
pnpm exec playwright install chromium
pnpm pack
dsh plugin --profile browser add ./dsh-browser-runtime-0.1.1.tgz
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
    maxScreenshotPixels: 16000000
    maxScreenshotBytes: 16777216
    allowPrivateNetwork: false
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

The default Provider uses a temporary isolated browser profile, a private scrubbed `HOME`, blocked service workers, no download or upload API, no arbitrary model-supplied JavaScript, no model-supplied selectors, and no connection to the user's Chrome profile. Navigation accepts only HTTP(S) URLs without embedded credentials. In strict mode, each environment sends HTTP(S), `ws:`/`wss:`, and proxied browser TCP through an authenticated loopback proxy. The proxy resolves a hostname once, requires every result to satisfy the address policy, and uses only those results for its upstream socket, preventing the browser from selecting a different DNS answer. Loopback, private, link-local, reserved, and multicast destinations are rejected by default.

Strict mode also disables QUIC and direct WebRTC UDP in the managed Chromium build, so WebTransport, HTTP/3, STUN, and TURN cannot create an unproxied path. `allowPrivateNetwork` is an explicit opt-in that omits the policy proxy and those launch restrictions, allowing direct HTTP, WebSocket, UDP, and QUIC connections including private destinations. Playwright request routes still reject unsupported protocols and embedded URL credentials. The Provider supports only the Chromium build managed by the pinned Playwright version.

The Provider exposes one page. Clicks whose effective link or form target would create another browsing context fail with `BROWSER_POLICY_DENIED` before dispatch. Page scripts receive `null` from `window.open`, and the triggering action receives the same policy failure. Any other unexpected Page is closed and drained before action or environment cleanup completes; v0.1 does not hand a popup back to the Agent.

Page dialogs are dismissed automatically, and their dismissal settles before the action returns. A dismissed confirm evaluates to `false`, and a dismissed prompt evaluates to `null`; v0.1 has no dialog-accept or prompt-input API.

File inputs fail with `BROWSER_POLICY_DENIED` before dispatch. The initialization script also blocks file-input activation through `click()`, `showPicker()`, click events, and associated labels; an unexpected Playwright FileChooser is cleared as a fallback. No host file path or file payload enters the page.

Links with a `download` attribute fail before dispatch. A navigation response whose `Content-Disposition` is `attachment` is stopped through Chromium control after its headers arrive, while other Playwright Download events are cancelled. The Provider enables Playwright download ownership only so it can cancel the transfer; it exposes no path, and BrowserContext cleanup deletes any partial artifact. A response-defined download can reach its server and transfer initial bytes before the attachment header is observed and stopped.

The BrowserContext grants no web permissions, and Chromium denies permission prompts. Geolocation, notifications, camera, microphone, clipboard read, clipboard write, and other permission-controlled browser APIs therefore report `denied` without opening host UI. A page action that requests a permission may succeed as an ordinary click while the page receives the denial.

Observed links and form submissions whose effective URL uses a protocol other than HTTP(S), `javascript:`, `blob:`, `data:`, or `about:` fail with `BROWSER_POLICY_DENIED` before dispatch. The initialization script also blocks external-protocol anchor clicks, form activation, and `form.submit()`; Chromium control stops renderer navigation such as a direct `location.href` assignment before it proceeds. These controlled paths do not invoke a host handler for `mailto:`, `tel:`, `file:`, or custom protocols.

Observation body text is sliced inside Chromium at the Runtime's `maxTextChars` before it crosses the Playwright protocol; `maxElements` bounds target metadata. Screenshot requests are checked against `maxScreenshotPixels` in device pixels before capture and `maxScreenshotBytes` after PNG encoding. Either limit returns `BROWSER_POLICY_DENIED` and prevents attachment persistence. The encoded-byte check cannot avoid the transient browser and Node.js allocation needed to produce and receive the PNG.

`browser_fill` is not a secret-entry channel. DSH logs raw tool-call arguments before this plugin runs, so secrets in the `value` argument remain in the Session log even though transition evidence redacts the value. Password inputs are rejected.

The proxy and browser launch controls are application-level egress restrictions, not an operating-system network sandbox. Use a host firewall or container network policy when the deployment requires an independent network boundary.

## Limits

v0.1 has no popup handoff, downloads, uploads, arbitrary JavaScript, real-Chrome attachment, cross-provider checkpoint conversion, IndexedDB/sessionStorage restore, credential management, or generic non-browser Environment API. Playwright-managed Chromium must be installed separately.

See [architecture and provider API](docs/architecture.md) for ownership, failure, evidence, and extension rules.
