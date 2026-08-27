/** Playwright provider plugin entrypoint. @module dsh-browser-runtime/playwright */

export { NetworkPolicy, isPublicAddress } from './provider/network-policy.ts'
export type { NetworkPolicyConfig } from './provider/network-policy.ts'
export {
  Config,
  PLAYWRIGHT_PROVIDER_ID,
  PlaywrightBrowserProvider,
  apply,
  inject,
  name,
} from './provider/playwright.ts'
export type { Config as PlaywrightBrowserConfig } from './provider/playwright.ts'
