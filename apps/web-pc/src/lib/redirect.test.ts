import { describe, expect, test } from 'bun:test'
import { sanitizeRedirect } from './redirect'

describe('sanitizeRedirect', () => {
  test('accepts canonical /pc paths', () => {
    expect(sanitizeRedirect('/pc/search?q=keyboard')).toBe('/pc/search?q=keyboard')
    expect(sanitizeRedirect('/pc')).toBe('/pc/')
    expect(sanitizeRedirect('/pc?tab=login')).toBe('/pc/?tab=login')
  })

  test('rejects paths that normalize outside /pc', () => {
    expect(sanitizeRedirect('/admin')).toBe('/pc/')
    expect(sanitizeRedirect('/pc/../admin')).toBe('/pc/')
    expect(sanitizeRedirect('//evil.example')).toBe('/pc/')
    expect(sanitizeRedirect('https://evil.example')).toBe('/pc/')
    expect(sanitizeRedirect(undefined)).toBe('/pc/')
  })

  test('never redirects back to login or register', () => {
    expect(sanitizeRedirect('/pc/login')).toBe('/pc/')
    expect(sanitizeRedirect('/pc/login/')).toBe('/pc/')
    expect(sanitizeRedirect('/pc/register/')).toBe('/pc/')
  })
})
