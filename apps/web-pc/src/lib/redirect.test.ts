import { describe, expect, test } from 'bun:test'
import { sanitizeRedirect } from './redirect'

describe('sanitizeRedirect', () => {
  test('accepts canonical /pc paths', () => {
    expect(sanitizeRedirect('/pc/search?q=keyboard')).toBe('/pc/search?q=keyboard')
    expect(sanitizeRedirect('/pc/search?q=keyboard#results')).toBe('/pc/search?q=keyboard#results')
    expect(sanitizeRedirect('/pc')).toBe('/pc/')
    expect(sanitizeRedirect('/pc?tab=login')).toBe('/pc/?tab=login')
    expect(sanitizeRedirect('/pc#section')).toBe('/pc/#section')
  })

  test('rejects paths that normalize outside /pc', () => {
    expect(sanitizeRedirect('/admin')).toBe('/pc/')
    expect(sanitizeRedirect('/pc/../admin')).toBe('/pc/')
    expect(sanitizeRedirect('//evil.example')).toBe('/pc/')
    expect(sanitizeRedirect('https://evil.example')).toBe('/pc/')
    expect(sanitizeRedirect(undefined)).toBe('/pc/')
  })

  test('never redirects back to the login page', () => {
    expect(sanitizeRedirect('/pc/login')).toBe('/pc/')
    expect(sanitizeRedirect('/pc/login/')).toBe('/pc/')
  })
})
