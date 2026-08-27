# dsh-browser-runtime

English | [中文](README.zh.md)

`dsh-browser-runtime` gives each DeepSeek Harness Agent a leased, stateful browser environment. It owns provider selection, Agent isolation, lifecycle, serialized operations, stale-reference checks, checkpoint indexing, and transition evidence. Playwright is one provider behind that API, and the model tools are a separate consumer.

This repository is one installable DSH bundle with three plugin entry points:

| Entry point | Role | Service or tools |
|---|---|---|
| `dsh-browser-runtime` | Service Definition and control plane | `ctx.browserRuntime` |
| `dsh-browser-runtime/playwright` | Playwright/Chromium Provider | provider id `playwright` |
| `dsh-browser-runtime/tools` | Model-facing Consumer | the `browser_*` tools |

The single-package layout supports `dsh plugin add github:...`. The source directories preserve the three roles so they can become separate npm packages if their release cycles diverge.

The two functional plugin entry points use named exports only. The DSH Loader resolves an imported module with `exports.default ?? exports`, so a default export would discard `inject`, `Config`, and `name` and the Provider would fail at `ctx.browserRuntime`. A default export is reserved for a Service or class plugin that carries `inject` and `Config` as static properties, which is why the runtime entry keeps `export { BrowserRuntime as default }`. `pnpm run verify:tarball` enforces this against the packed archive.

## v0.1 behavior

- One isolated BrowserContext and one Page per exact Agent object.
- Concurrent acquisition by the same owner shares setup and returns independent leases; different owners never share an environment.
- Cancelling one acquire or tool call stops only that caller's wait; another waiter can finish the shared owner setup.
- Cancelling an active browser operation releases the possibly unusable Agent lease; the next tool call opens or restores a fresh environment.
- Operations for one environment run FIFO; separate environments may run concurrently.
- Each observation mints local refs such as `e1`. Only refs from the latest observation are accepted.
- Observations are ranked into five tiers — form controls and pagination, site navigation, record titles, body links, then repeated per-record links — so a budget cut drops author links before it drops a paging link. Repeating page records collapse into groups such as `g1`, and a `dt`/`dd` pair counts as one record.
- `browser_observe` takes a `mode` (`summary`, `interactive`, `document`) plus `max_text_chars` and `max_elements`. `browser_observe_next` reads the rest of the newest observation without re-observing, so element refs stay valid while paging.
- Every action produces before/after transition evidence with timing and output-size metrics. Fill values are redacted from runtime evidence.
- Tool failures append one machine-routable line: `code`, `url`, `observation`, `lease`, `recommended_action`, `retryable`. Nothing is retried automatically, because a click that failed may still have navigated.
- A compact transition-index write failure warns the operator without changing action success, Provider failure, or cancellation; current-process queries retain the bounded in-memory record.
- Screenshots are PNG attachments through `ctx.attachments`; the model cannot choose a host path.
- `resume` checkpoints cookies and localStorage. A restore creates a new generation, invalidating every prior page, observation, and element identity. Checkpoint payload creation, index commit or rollback, and old-payload cleanup serialize per session across owner objects; one Provider cannot replace another Provider's session checkpoint.
- Provider unload aborts and waits selection/opening before provider-wide disposal; last-lease release, Agent disposal, and runtime unload also await browser cleanup.

The model tools are:

| Tool | Purpose |
|---|---|
| `browser_open` | Navigate to an HTTP(S) URL and return an observation |
| `browser_observe` | Refresh page text and interactive element refs in a chosen mode |
| `browser_observe_next` | Read the next page of the newest observation |
| `browser_click` | Click a ref from the latest observation |
| `browser_fill` | Fill a non-password ref with non-secret text |
| `browser_fill_credential` | Fill a ref with a stored secret named by reference |
| `browser_press` | Send one allowlisted key to a ref or the focused element |
| `browser_select` | Choose options in a select ref |
| `browser_check` | Set a checkbox or radio ref |
| `browser_scroll` | Scroll by viewport multiples, to an end, or to a ref |
| `browser_back` / `browser_forward` / `browser_reload` | Move through this environment's own history |
| `browser_wait` | Wait for a page or element state, then observe |
| `browser_screenshot` | Save a viewport or full-page PNG attachment |
| `browser_extract_list` / `_table` / `_links` / `_article` | Read structured content from a region |

`browser_fill_credential` is registered only where a credential source is configured. Extraction tools take a `region_ref` from the latest observation, never a selector and never JavaScript; an element reference widens to the region a caller means by it, so naming one record's link extracts the whole listing. The browser suits interactive pages: for hundreds or thousands of static records, an official API or a direct fetch beats paging through it, and the system prompt says so.

## Develop and test

Prerequisites are Node.js `^22.19` or `>=24` and pnpm 10.

```sh
pnpm install
node lib/cli/index.js install chromium
pnpm run typecheck
pnpm run test:coverage
pnpm run build
pnpm run lint:package
pnpm run verify:package
pnpm run verify:tarball
```

`pnpm test` uses a real local HTTP server and Chromium when Playwright's managed browser is present. The Playwright suite self-skips when Chromium is absent; CI installs it explicitly.

### Scenario coverage

| Scenario | Covered by |
|---|---|
| Open a public static page | `playwright.integration.spec.ts` |
| Fill a search box and press Enter | `playwright-observation.integration.spec.ts` |
| Act on the observation an action returned | `browser-tools.spec.ts`, `tool.integration.spec.ts` |
| Act on a superseded reference and get a stale error | `browser-tools.spec.ts`, `playwright-observation.integration.spec.ts` |
| Asynchronous page update after a click | `playwright-observation.integration.spec.ts` |
| Select, checkbox, and scroll | `playwright-observation.integration.spec.ts` |
| Full-page screenshot | `playwright.integration.spec.ts` |
| Private network denied by default, admitted by allowlist | `network-policy.spec.ts`; the real-browser suites run under `mode: allowlist` |
| Cookie and localStorage checkpoint restore | `playwright.integration.spec.ts`, `storage.integration.spec.ts` |
| Lease rebuilt after a cancelled operation | `tool.integration.spec.ts` |
| Two Agents isolated in parallel | `browser-tools.spec.ts`, `runtime.spec.ts` |
| Provider unload and resource reclamation | `runtime.spec.ts` |
| Missing-Chromium diagnosis | `startup-diagnostics.spec.ts`, `cli-main.spec.ts` |
| The final tarball mounts and registers its tools | `verify:tarball` |

`verify:tarball` mounts the packed archive in a real Cordis Context with the real DSH tool, system-prompt, and attachment services, and runs `doctor` against the extracted files. It is not a `dsh` profile install: nothing here drives the `dsh` CLI, so the last mile — `dsh plugin --profile web add -w …` followed by a real profile start — still needs a manual check on a machine that has DSH.

`verify:package` runs the artifact conformance gate over the built tree, and `verify:tarball` packs, extracts, and re-runs it over the exact archive a profile installs: every `exports` subpath resolves, the functional plugin entries carry no default export, the real `Loader.unwrapExports` keeps their `inject`/`Config`/`name`, all three entries mount in a real Cordis Context, `doctor` runs against the extracted files, and the report prints the package version, source commit, and an integrity digest of the entry points.

## Install into DeepSeek Harness

A DSH profile is a pnpm workspace root, so `add` needs `-w`. The plugin ships its
own browser installer and a diagnostic command, so no step depends on where pnpm
happens to place the transitive `playwright` dependency:

```sh
dsh plugin --profile web add -w dsh-browser-runtime
dsh-browser-runtime install chromium
dsh-browser-runtime doctor
```

For a local checkout, build a tarball and install that path instead:

```sh
pnpm install
pnpm pack
dsh plugin --profile web add -w ./dsh-browser-runtime-0.1.2.tgz
dsh-browser-runtime install chromium
dsh-browser-runtime doctor
dsh --profile web --dump-config
```

For a GitHub installation, pin a commit:

```sh
dsh plugin --profile web add -w github:YOUR_ACCOUNT/dsh-browser-runtime#COMMIT_SHA
dsh-browser-runtime install chromium
```

`dsh-browser-runtime doctor` reports the Node version, plugin version, Playwright
version, whether Chromium exists and where, the export shape each entry point
presents to the DSH Loader, whether the bundle patch shipped, and whether the
Provider can open an environment. It exits non-zero when any check fails, so a
profile setup script can gate on it.

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
    network:
      mode: strict # strict | allowlist | unrestricted
      allowHosts: []
      allowCidrs: []
      denyCidrs: []
    # checkpointRoot: /private/absolute/path
```

Tool row:

```yaml
- id: tool-browser
  config:
    provider: playwright
    persistence: ephemeral # or resume
    timeoutMs: 30000
    observeMode: summary # or interactive, document
    maxTextChars: 12000
    maxElements: 100
    # credentials:
    #   requireApproval: true
    #   refs:
    #     ci-token: DSH_BROWSER_CI_TOKEN
```

`observeMode` sets the default for calls that name no mode, and `maxTextChars`/`maxElements` cap what any single response may carry. The runtime row's `maxTextChars` is the separate ceiling on what one observation retains from the page.

Runtime checkpoint retention is bounded by `checkpointTtlMs` (`0` retains indefinitely) and `maxCheckpoints`. Pruning runs when the durable index loads; `ctx.browserRuntime.pruneCheckpoints()` and `listCheckpoints()` expose it, and `dsh-browser-runtime checkpoints [--clear]` lists or deletes the Provider-private payloads. A record keeps the Provider build that wrote it, and a restore refuses a payload from a different build.

With `persistence: resume`, checkpoints restore inside the same process from the runtime's in-memory index. Cross-process restore additionally requires DSH's `ctx.storageDomain`; the Web profile already mounts it. Checkpoint metadata goes to the `browser_runtime` domain, while Playwright stores the sensitive storage-state payload under `$DSH_HOME/browser-runtime/providers/playwright/v1/checkpoints` with owner-only permissions.

## Security limits

The default Provider uses a temporary isolated browser profile, a private scrubbed `HOME`, blocked service workers, no download or upload API, no arbitrary model-supplied JavaScript, no model-supplied selectors, and no connection to the user's Chrome profile. Navigation accepts only HTTP(S) URLs without embedded credentials. In strict mode, each environment sends HTTP(S), `ws:`/`wss:`, and proxied browser TCP through an authenticated loopback proxy. The proxy resolves a hostname once, requires every result to satisfy the address policy, and uses only those results for its upstream socket, preventing the browser from selecting a different DNS answer. Loopback, private, link-local, reserved, and multicast destinations are rejected by default.

Strict mode also disables QUIC and direct WebRTC UDP in the managed Chromium build, so WebTransport, HTTP/3, STUN, and TURN cannot create an unproxied path.

`network.mode: allowlist` keeps every one of those controls and admits only the hosts in `allowHosts` and the ranges in `allowCidrs`. An `allowHosts` entry matches the hostname exactly; a leading dot matches that host and its subdomains. `denyCidrs` is checked ahead of any allowance and applies in every mode, so a link-local range such as `169.254.0.0/16` stays unreachable even in a profile that admits loopback. Prefer this over the old switch:

```yaml
network:
  mode: allowlist
  allowHosts: [localhost, .dev.internal.example]
  allowCidrs: [127.0.0.1/32]
  denyCidrs: [169.254.0.0/16]
```

`network.mode: unrestricted` omits the policy proxy and those launch restrictions, allowing direct HTTP, WebSocket, UDP, and QUIC connections including private destinations. The deprecated `allowPrivateNetwork: true` maps to it; combining it with a contradicting `network.mode` fails at load. Playwright request routes still reject unsupported protocols and embedded URL credentials in every mode. The Provider supports only the Chromium build managed by the pinned Playwright version.

The Provider exposes one page. Clicks whose effective link or form target would create another browsing context fail with `BROWSER_POLICY_DENIED` before dispatch. Page scripts receive `null` from `window.open`, and the triggering action receives the same policy failure. Any other unexpected Page is closed and drained before action or environment cleanup completes; v0.1 does not hand a popup back to the Agent.

Page dialogs are dismissed automatically, and their dismissal settles before the action returns. A dismissed confirm evaluates to `false`, and a dismissed prompt evaluates to `null`; v0.1 has no dialog-accept or prompt-input API.

File inputs fail with `BROWSER_POLICY_DENIED` before dispatch. The initialization script also blocks file-input activation through `click()`, `showPicker()`, click events, and associated labels; an unexpected Playwright FileChooser is cleared as a fallback. No host file path or file payload enters the page.

Links with a `download` attribute fail before dispatch. A navigation response whose `Content-Disposition` is `attachment` is stopped through Chromium control after its headers arrive, while other Playwright Download events are cancelled. The Provider enables Playwright download ownership only so it can cancel the transfer; it exposes no path, and BrowserContext cleanup deletes any partial artifact. A response-defined download can reach its server and transfer initial bytes before the attachment header is observed and stopped.

The BrowserContext grants no web permissions, and Chromium denies permission prompts. Geolocation, notifications, camera, microphone, clipboard read, clipboard write, and other permission-controlled browser APIs therefore report `denied` without opening host UI. A page action that requests a permission may succeed as an ordinary click while the page receives the denial.

Observed links and form submissions whose effective URL uses a protocol other than HTTP(S), `javascript:`, `blob:`, `data:`, or `about:` fail with `BROWSER_POLICY_DENIED` before dispatch. The initialization script also blocks external-protocol anchor clicks, form activation, and `form.submit()`; Chromium control stops renderer navigation such as a direct `location.href` assignment before it proceeds. These controlled paths do not invoke a host handler for `mailto:`, `tel:`, `file:`, or custom protocols.

Observation body text is sliced inside Chromium at the Runtime's `maxTextChars` before it crosses the Playwright protocol; `maxElements` bounds target metadata. Screenshot requests are checked against `maxScreenshotPixels` in device pixels before capture and `maxScreenshotBytes` after PNG encoding. Either limit returns `BROWSER_POLICY_DENIED` and prevents attachment persistence. The encoded-byte check cannot avoid the transient browser and Node.js allocation needed to produce and receive the PNG.

`browser_fill` is not a secret-entry channel. DSH logs raw tool-call arguments before this plugin runs, so secrets in the `value` argument remain in the Session log even though transition evidence redacts the value. Password inputs are rejected.

`browser_fill_credential` is that channel. The model supplies only a `credential_ref`; the plaintext is resolved from a `ctx.browserCredentials` service the deployment mounts, or from the configured environment-variable mapping, and is handed straight to the Provider. It never enters a model request, a tool argument, transition evidence, or the Session log — evidence keeps the reference and `[REDACTED]`. Each fill goes through `ctx.approval` unless `credentials.requireApproval` is disabled, and requiring approval without an approval service mounted denies every fill rather than falling open. The tool is registered only where a credential source is configured.

The proxy and browser launch controls are application-level egress restrictions, not an operating-system network sandbox. Use a host firewall or container network policy when the deployment requires an independent network boundary.

## Limits

v0.1 has no popup handoff, downloads, uploads, arbitrary JavaScript, real-Chrome attachment, cross-provider checkpoint conversion, IndexedDB/sessionStorage restore, or generic non-browser Environment API. Checkpoint payloads are owner-only files on disk rather than encrypted or key-managed storage. There is no dedicated browser Web UI and no CDP Provider for attaching to a running Chrome. Playwright-managed Chromium must be installed separately.

See [architecture and provider API](docs/architecture.md) for ownership, failure, evidence, and extension rules.
