import { describe, expect, test } from 'bun:test'
import { createBrandAssetsRouter } from './router'

const app = createBrandAssetsRouter()

/** PNG 魔数：邮件客户端与 GitHub 都按字节判断图片，返回 HTML/文本会被判为坏图。 */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

describe('品牌静态图路由（#325：apps/web 移除后由 API 托管）', () => {
  for (const name of ['logo.png', 'brand-fish.png']) {
    test(`/brand/${name} 返回真实 PNG`, async () => {
      const res = await app.request(`/brand/${name}`)

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/png')
      expect(res.headers.get('cache-control')).toBe('public, max-age=86400')
      const bytes = new Uint8Array(await res.arrayBuffer())
      expect([...bytes.slice(0, PNG_MAGIC.length)]).toEqual(PNG_MAGIC)
    })
  }

  test('白名单外的名字与目录穿越都 404', async () => {
    for (const path of [
      '/brand/missing.png',
      '/brand/brand-wordmark.png',
      '/brand/%2e%2e%2f%2e%2e%2fpackage.json',
    ]) {
      const res = await app.request(path)
      expect(res.status).toBe(404)
    }
  })
})
