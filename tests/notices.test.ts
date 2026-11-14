import { describe, expect, it } from 'vitest'
import { activeNotices, compareVersions } from '../src/shared/notices'

const NOW = Date.UTC(2026, 10, 14, 12)

describe('versions', () => {
  it('orders releases and their betas', () => {
    expect(compareVersions('0.3.0-beta.1', '0.3.0-beta.2')).toBeLessThan(0)
    expect(compareVersions('0.3.0-beta.2', '0.3.0')).toBeLessThan(0)
    expect(compareVersions('0.3.1-beta.1', '0.3.0')).toBeGreaterThan(0)
    expect(compareVersions('v0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('0.3.0-beta.1', '0.3.0-beta.1')).toBe(0)
  })
})

describe('team notices', () => {
  const file = (notices: unknown[], extra = {}) => ({ notices, ...extra })

  it('shows a notice inside its window and version range only', () => {
    const n = { id: 'a', title: 'Hello', body: 'Body' }
    expect(activeNotices(file([n]), '0.3.0', NOW).notices).toHaveLength(1)
    expect(activeNotices(file([{ ...n, until: new Date(NOW - 1).toISOString() }]), '0.3.0', NOW).notices).toHaveLength(0)
    expect(activeNotices(file([{ ...n, from: new Date(NOW + 1).toISOString() }]), '0.3.0', NOW).notices).toHaveLength(0)
    expect(activeNotices(file([{ ...n, versionsBelow: '0.3.0' }]), '0.3.0-beta.1', NOW).notices).toHaveLength(1)
    expect(activeNotices(file([{ ...n, versionsBelow: '0.3.0' }]), '0.3.0', NOW).notices).toHaveLength(0)
  })

  it('drops a bad entry on its own and a link off the allowed sites', () => {
    const out = activeNotices(file([{ id: 'x' }, { id: 'b', title: 'Ok', link: 'https://evil.example.com/x' }, { id: 'c', title: 'Ok', link: 'https://github.com/Web3kaneco/lazy-edge-app/releases' }]), '0.3.0', NOW)
    expect(out.notices.map((n) => n.id)).toEqual(['b', 'c'])
    expect(out.notices[0]!.link).toBeUndefined()
    expect(out.notices[1]!.link).toBe('https://github.com/Web3kaneco/lazy-edge-app/releases')
    expect(out.notices[0]!.level).toBe('info')
  })

  it('requires an update only below the stated version', () => {
    const f = file([], { upgradeBelow: '0.3.1-beta.1', upgradeReason: 'Fixes repeat buys.' })
    expect(activeNotices(f, '0.3.0-beta.1', NOW)).toMatchObject({ upgradeBelow: '0.3.1-beta.1', upgradeReason: 'Fixes repeat buys.' })
    expect(activeNotices(f, '0.3.1-beta.1', NOW).upgradeBelow).toBeNull()
  })

  it('reads a broken file as nothing to show', () => {
    expect(activeNotices('not json', '0.3.0', NOW)).toEqual({ notices: [], upgradeBelow: null, upgradeReason: null })
  })
})
