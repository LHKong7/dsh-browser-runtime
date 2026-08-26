import { describe, expect, it } from 'vitest'
import { isPublicAddress, NetworkPolicy } from 'dsh-browser-runtime/playwright'

describe('Playwright network policy', () => {
  it('classifies public and non-public address ranges', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true)
    expect(isPublicAddress('127.0.0.1')).toBe(false)
    expect(isPublicAddress('10.0.0.1')).toBe(false)
    expect(isPublicAddress('169.254.1.1')).toBe(false)
    expect(isPublicAddress('::1')).toBe(false)
    expect(isPublicAddress('fc00::1')).toBe(false)
    expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false)
  })

  it('rejects local hosts and non-HTTP protocols unless private access is enabled', async () => {
    const strict = new NetworkPolicy({ allowPrivateNetwork: false })
    await expect(strict.assertAllowed('http://localhost/')).rejects.toThrow(/local hostname/)
    await expect(strict.assertAllowed('http://127.0.0.1/')).rejects.toThrow(/non-public address/)
    await expect(strict.assertAllowed('file:///etc/passwd')).rejects.toThrow(/non-HTTP/)
    await expect(strict.assertAllowed('https://user:pass@example.com/')).rejects.toThrow(/credentials/)

    const local = new NetworkPolicy({ allowPrivateNetwork: true })
    await expect(local.assertAllowed('http://127.0.0.1/')).resolves.toBeUndefined()
  })
})
