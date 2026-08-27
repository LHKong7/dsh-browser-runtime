/** Playwright provider plugin entrypoint. @module dsh-browser-runtime/playwright */

export { NetworkPolicy, isPublicAddress, usesPolicyProxy } from './provider/network-policy.ts'
export type { NetworkPolicyConfig, NetworkPolicyMode } from './provider/network-policy.ts'
export { chromiumMissingMessage, readChromiumInstallation } from './provider/chromium.ts'
export type { ChromiumInstallation } from './provider/chromium.ts'
export {
  Config,
  PLAYWRIGHT_PROVIDER_ID,
  PlaywrightBrowserProvider,
  apply,
  inject,
  name,
} from './provider/playwright.ts'
export type {
  Config as PlaywrightBrowserConfig,
  NetworkPolicyConfigInput,
} from './provider/playwright.ts'
