#!/usr/bin/env node
/**
 * Artifact-level conformance gate for the built bundle.
 *
 * Source tests prove the entry points behave; this script proves the files a
 * profile actually installs behave. It resolves every `exports` subpath of a
 * package root, rejects a `default` re-export in the functional plugin
 * entries, unwraps each namespace with the real DSH Loader, mounts all three
 * plugins in a real Cordis Context, and prints the build identity a release
 * report needs.
 *
 * Usage: node scripts/verify-package.mjs [packageRoot]
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const packageRoot = resolve(process.argv[2] ?? process.cwd())

const { Loader } = await import('@deepseek-ai/cordis-plugin-loader')
const { Context } = await import('@deepseek-ai/cordis')
const { AttachmentId, AttachmentStore } = await import('@deepseek-ai/dsh-attachment')
const SystemPrompt = (await import('@deepseek-ai/dsh-system-prompt')).default
const ToolRuntime = (await import('@deepseek-ai/dsh-tools')).default

const unwrapExports = Loader.prototype.unwrapExports

/** Entry points the DSH bundle patch mounts, in dependency order. */
const ENTRIES = [
  {
    subpath: '.',
    pluginName: 'browser-runtime',
    shape: 'service',
    config: { provider: 'playwright' },
  },
  {
    subpath: './playwright',
    pluginName: 'browser-playwright',
    shape: 'functional',
    inject: ['browserRuntime'],
    config: { headless: true },
  },
  {
    subpath: './tools',
    pluginName: 'tool-browser',
    shape: 'functional',
    inject: ['tools', 'browserRuntime', 'systemPrompt', 'attachments'],
    config: { provider: 'playwright' },
  },
]

const failures = []

function check(condition, message) {
  if (!condition) failures.push(message)
  return condition
}

class StubAttachments extends AttachmentStore {
  imageLimits = {
    maxImageBytes: 1_000_000,
    maxImagesPerMessage: 10,
    maxMessageImageBytes: 10_000_000,
    maxImagePixels: 1_000_000,
    maxImageDimension: 2_000,
    mediaTypes: ['image/png'],
  }

  validateImage() {
    return Promise.resolve()
  }

  saveImage(input) {
    return Promise.resolve({
      attachmentId: AttachmentId(`sha256:${'0'.repeat(64)}`),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
    })
  }

  readImage() {
    throw new Error('not used')
  }
}

const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))

/** Resolve one `exports` subpath to an absolute file inside the package root. */
function resolveSubpath(subpath) {
  const entry = manifest.exports?.[subpath]
  const target = typeof entry === 'string' ? entry : entry?.default
  if (typeof target !== 'string') throw new Error(`package.json exports has no default target for "${subpath}"`)
  return resolve(packageRoot, target)
}

/** Reject any construct the Loader would collapse into a bare default export. */
function assertNoDefaultExport(subpath, source) {
  const patterns = [
    /^\s*export\s*\{[^}]*\bdefault\b[^}]*\}/m,
    /^\s*export\s+default\b/m,
  ]
  for (const pattern of patterns) {
    check(
      !pattern.test(source),
      `${subpath}: built output declares a default export; Loader.unwrapExports would drop inject/Config/name`,
    )
  }
}

const loaded = new Map()

for (const entry of ENTRIES) {
  const filename = resolveSubpath(entry.subpath)
  const source = await readFile(filename, 'utf8')
  if (entry.shape === 'functional') assertNoDefaultExport(entry.subpath, source)

  const namespace = await import(pathToFileURL(filename).href)
  const plugin = unwrapExports(namespace)
  loaded.set(entry.subpath, plugin)

  if (entry.shape === 'functional') {
    check(plugin === namespace, `${entry.subpath}: Loader replaced the namespace with a default export`)
    check(typeof plugin?.apply === 'function', `${entry.subpath}: unwrapped plugin has no apply()`)
    check(plugin?.name === entry.pluginName, `${entry.subpath}: unwrapped plugin name is "${plugin?.name}"`)
    check(
      JSON.stringify(plugin?.inject) === JSON.stringify(entry.inject),
      `${entry.subpath}: unwrapped inject is ${JSON.stringify(plugin?.inject)}`,
    )
    check(typeof plugin?.Config === 'function', `${entry.subpath}: unwrapped plugin has no Config schema`)
  } else {
    check(typeof plugin === 'function', `${entry.subpath}: unwrapped Service entry is not a class`)
    check(typeof plugin?.Config === 'function', `${entry.subpath}: Service class carries no static Config`)
  }

  const types = manifest.exports?.[entry.subpath]?.types
  check(typeof types === 'string', `${entry.subpath}: package.json exports declares no types target`)
  if (typeof types === 'string') {
    await readFile(resolve(packageRoot, types), 'utf8').catch(() => {
      failures.push(`${entry.subpath}: declaration file ${types} is missing from the package`)
    })
  }
}

check(
  typeof manifest.dsh?.bundle?.patch === 'string',
  'package.json declares no dsh.bundle.patch; a profile would install no rows',
)
if (typeof manifest.dsh?.bundle?.patch === 'string') {
  await readFile(resolve(packageRoot, manifest.dsh.bundle.patch), 'utf8').catch(() => {
    failures.push(`bundle patch ${manifest.dsh.bundle.patch} is missing from the package`)
  })
}

check(
  typeof manifest.bin?.['dsh-browser-runtime'] === 'string',
  'package.json declares no dsh-browser-runtime bin; install/doctor would be unavailable',
)
if (typeof manifest.bin?.['dsh-browser-runtime'] === 'string') {
  await readFile(resolve(packageRoot, manifest.bin['dsh-browser-runtime']), 'utf8').catch(() => {
    failures.push(`bin ${manifest.bin['dsh-browser-runtime']} is missing from the package`)
  })
}

if (failures.length === 0) {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    new StubAttachments(ctx)
    for (const entry of ENTRIES) await ctx.plugin(loaded.get(entry.subpath), entry.config)
    const providers = await ctx.browserRuntime.listProviders()
    check(
      providers.some(provider => provider.id === 'playwright'),
      'the mounted bundle registered no playwright provider',
    )
    const tools = ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('browser_'))
    check(tools.length > 0, 'the mounted bundle registered no browser_* tools')
    report(providers, tools)
  } finally {
    await ctx.fiber.dispose()
  }
}

function sourceCommit() {
  for (const argv of [['rev-parse', 'HEAD'], ['rev-parse', '--short', 'HEAD']]) {
    try {
      return execFileSync('git', argv, { cwd: packageRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      // A packed tarball has no git metadata; fall through to the environment.
    }
  }
  return process.env.GITHUB_SHA ?? '(unknown)'
}

async function integrityDigest() {
  const files = ENTRIES.map(entry => resolveSubpath(entry.subpath)).sort()
  const digest = createHash('sha256')
  for (const filename of files) {
    digest.update(basename(filename))
    digest.update(await readFile(filename))
  }
  return digest.digest('hex')
}

function report(providers, tools) {
  const lines = [
    `package:    ${manifest.name}@${manifest.version}`,
    `root:       ${packageRoot}`,
    `commit:     ${sourceCommit()}`,
    `playwright: ${manifest.dependencies?.playwright ?? '(none)'}`,
    `entries:    ${ENTRIES.map(entry => entry.pluginName).join(', ')} mounted`,
    `providers:  ${providers.map(provider => `${provider.id}${provider.available ? '' : ' (unavailable)'}`).join(', ')}`,
    `tools:      ${tools.length} registered (${tools.slice(0, 4).join(', ')}${tools.length > 4 ? ', …' : ''})`,
  ]
  console.log(lines.join('\n'))
}

if (failures.length > 0) {
  console.error(`package conformance failed for ${packageRoot}:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log(`integrity:  sha256:${await integrityDigest()}`)
  console.log('package conformance passed')
}
