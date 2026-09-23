import { describe, expect, test } from 'bun:test'
import { createBunS3MediaStorage, isSafeObjectKey, type MediaStorage } from './storage'

/**
 * 真对象存储的集成测试。
 *
 * 与 `service.test.ts` 的 fake `MediaStorage` 互补：这里验证的是**实测过的事实**——
 * presign 出来的 URL 真的能 PUT、`stat()` 真的能读到 `size`/`type`、公开 URL 真的能匿名 GET
 * （契约 §7.7 / §7.8 的依据）。CI 由 workflow 里的 MinIO step 提供，本地由 `bun run db:up` 提供；
 * 探测不到就跳过，避免开发机上没起 MinIO 时变成假失败。
 */
const USER_ID = '01930000-0000-7000-8000-00000000000a'

type S3Config = {
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  publicUrl: string
}

function loadS3Config(): S3Config | null {
  const {
    S3_ENDPOINT,
    S3_REGION,
    S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY,
    S3_BUCKET,
    S3_PUBLIC_URL,
  } = process.env

  if (
    !S3_ENDPOINT ||
    !S3_REGION ||
    !S3_ACCESS_KEY_ID ||
    !S3_SECRET_ACCESS_KEY ||
    !S3_BUCKET ||
    !S3_PUBLIC_URL
  ) {
    return null
  }

  return {
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
    bucket: S3_BUCKET,
    publicUrl: S3_PUBLIC_URL,
  }
}

const config = loadS3Config()

const client = config
  ? new Bun.S3Client({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      bucket: config.bucket,
      endpoint: config.endpoint,
      region: config.region,
    })
  : null

/** 用一次 HEAD 探测存储是否真的可用（对象不存在也算可用，只要能拿到响应）。 */
async function probeStorage(): Promise<boolean> {
  if (!client) return false
  try {
    await client.exists('__reachability_probe__')
    return true
  } catch {
    return false
  }
}

const storage: MediaStorage | null =
  client && config ? createBunS3MediaStorage({ client, publicUrlBase: config.publicUrl }) : null

const reachable = await probeStorage()

describe('Bun S3 存储适配', () => {
  test.skipIf(!reachable)('presign → PUT → stat → 匿名 GET 全链路可跑通', async () => {
    const media = storage
    if (!media) throw new Error('storage 未初始化')

    const key = `listings/${USER_ID}/${crypto.randomUUID()}.jpg`
    const bytes = new Uint8Array(1024)

    const signed = media.presignPut({ key, contentType: 'image/jpeg' })
    expect(signed.url).toContain(key)
    // Bun 的签名只覆盖 host，因此当前不需要客户端附带任何额外头（契约 §7.7）
    expect(signed.headers).toEqual({})

    const put = await fetch(signed.url, {
      method: 'PUT',
      body: bytes,
      headers: { 'Content-Type': 'image/jpeg' },
    })
    expect(put.status).toBe(200)

    const stat = await media.stat(key)
    expect(stat).toEqual({ size: 1024, contentType: 'image/jpeg' })

    // 公开 URL 依赖桶的匿名读策略（契约 §7.8）
    const anonymous = await fetch(media.publicUrl(key))
    expect(anonymous.status).toBe(200)

    await client?.delete(key)
    expect(await media.stat(key)).toBeNull()
  })

  test.skipIf(!reachable)('stat 对不存在的对象返回 null 而不是抛错', async () => {
    const media = storage
    if (!media) throw new Error('storage 未初始化')

    expect(await media.stat(`listings/${USER_ID}/${crypto.randomUUID()}.jpg`)).toBeNull()
  })
})

// #86 B 线评审 P1：`Bun.S3Client` 用 `new URL()` 拼地址，pathname 会把 `..` 归一化掉，
// 于是调用方的 `startsWith(prefix)` 归属校验可以被绕过。防线放在这里。
describe('isSafeObjectKey（objectKey 形状白名单）', () => {
  test('放行服务端自己生成的键', () => {
    expect(isSafeObjectKey(`listings/${USER_ID}/01930000-0000-7000-8000-0000000000f1.jpg`)).toBe(
      true,
    )
    expect(isSafeObjectKey(`chat-media-final/${USER_ID}/${USER_ID}/x.webp`)).toBe(true)
  })

  test('拒绝会被 URL 归一化、或带路径语义的键', () => {
    for (const key of [
      `listings/${USER_ID}/../${USER_ID}/x.jpg`,
      'listings/a/./x.jpg',
      'listings/a//x.jpg',
      'listings/a/../../etc/passwd',
      '/listings/a/x.jpg',
      'listings\\a\\x.jpg',
      'listings/a/..%2fx.jpg',
      'listings/a/%2e%2e/x.jpg',
      '',
      'a'.repeat(257),
    ]) {
      expect(isSafeObjectKey(key)).toBe(false)
    }
  })
})

describe('stat 的形状防线（不发请求就拒绝）', () => {
  test('含 `..` 的键当作不存在，且一个请求都不会打到存储端点', async () => {
    const seen: string[] = []
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push(new URL(request.url).pathname)
        return new Response(null, { status: 404 })
      },
    })

    try {
      const media = createBunS3MediaStorage({
        client: new Bun.S3Client({
          endpoint: `http://127.0.0.1:${server.port}`,
          region: 'us-east-1',
          accessKeyId: 'test',
          secretAccessKey: 'test',
          bucket: 'fish',
        }),
        publicUrlBase: `http://127.0.0.1:${server.port}/fish`,
      })

      const traversed = await media.stat(`listings/${USER_ID}/../${USER_ID}/x.jpg`)
      expect(traversed).toBeNull()
      expect(seen).toEqual([])

      // 对照组：形状合法的键会真的打到端点（证明上面的空数组不是因为压根没接上）
      expect(await media.stat(`listings/${USER_ID}/x.jpg`)).toBeNull()
      expect(seen).toHaveLength(1)
    } finally {
      await server.stop(true)
    }
  })
})
