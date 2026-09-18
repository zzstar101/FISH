/** PR #79: scratch DB + real API process + MinIO. Run: bun --env-file=.env apps/api/scripts/media-smoke.ts */
import assert from 'node:assert/strict'
import { createDb } from '@fish/db/client'
import { loadServerEnv } from '@fish/shared/env'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createSessions } from '../src/modules/auth/session'

const env = loadServerEnv()
const scratch = `fish_media_smoke_${process.pid}`
const url = new URL(env.DATABASE_URL)
url.pathname = `/${scratch}`
const admin = createDb(env.DATABASE_URL)
const db = createDb(url.toString())
const client = new Bun.S3Client({
  endpoint: env.S3_ENDPOINT,
  bucket: env.S3_BUCKET,
  region: env.S3_REGION,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
})
const keys: string[] = []
let api: ReturnType<typeof Bun.spawn> | undefined
const portProbe = Bun.serve({ port: 0, fetch: () => new Response() })
const port = portProbe.port
portProbe.stop(true)
const base = `http://localhost:${port}`

try {
  await admin.$client.unsafe(`CREATE DATABASE "${scratch}"`)
  await migrate(db, {
    migrationsFolder: Bun.fileURLToPath(
      new URL('../../../packages/db/src/migrations', import.meta.url),
    ),
  })
  const buyer = crypto.randomUUID()
  const seller = crypto.randomUUID()
  const outsider = crypto.randomUUID()
  const listing = crypto.randomUUID()
  const conversation = crypto.randomUUID()
  for (const [i, id] of [buyer, seller, outsider].entries()) {
    await db.execute(sql`INSERT INTO users (id, student_no, password_hash, nickname)
      VALUES (${id}, ${`media${process.pid}_${i}`}, 'test-hash', 'media smoke')`)
  }
  await db.execute(sql`INSERT INTO listings (id, seller_id, title, description, price_cents, category, condition, status)
    VALUES (${listing}, ${seller}, 'test', 'test', 100, 'DIGITAL', 'GOOD', 'ACTIVE')`)
  await db.execute(sql`INSERT INTO conversations (id, listing_id, buyer_id, seller_id)
    VALUES (${conversation}, ${listing}, ${buyer}, ${seller})`)
  const session = createSessions(db)
  const cookie = `fish_session=${(await session.create(buyer)).token}`
  const otherCookie = `fish_session=${(await session.create(outsider)).token}`
  api = Bun.spawn([process.execPath, 'apps/api/src/index.ts'], {
    env: {
      ...process.env,
      DATABASE_URL: url.toString(),
      API_PORT: String(port),
      MAIL_TRANSPORT: 'outbox',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  let ready = false
  for (let i = 0; i < 100; i++) {
    if (api.exitCode !== null) throw new Error('API exited before readiness')
    try {
      ready = (await fetch(`${base}/health`)).ok
    } catch {
      /* startup */
    }
    if (ready) break
    await Bun.sleep(100)
  }
  assert(ready, 'API readiness')
  const bytes = new Uint8Array(
    await Bun.file(
      new URL('../src/modules/messages/fixtures/voice-fragmented.mp4', import.meta.url),
    ).arrayBuffer(),
  )
  const mediaPath = `/conversations/${conversation}/media`
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' }
  const response = await fetch(`${base}${mediaPath}/presign`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'VOICE', contentType: 'audio/mp4', sizeBytes: bytes.length }),
  })
  assert.equal(response.status, 200)
  const signed = (await response.json()) as {
    uploadUrl: string
    objectKey: string
    headers: Record<string, string>
  }
  keys.push(signed.objectKey)
  assert.equal(
    (
      await fetch(signed.uploadUrl, {
        method: 'PUT',
        headers: { ...signed.headers, 'Content-Type': 'audio/mp4' },
        body: bytes,
      })
    ).status,
    200,
  )
  const created = await fetch(`${base}${mediaPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kind: 'VOICE',
      contentType: 'audio/mp4',
      sizeBytes: bytes.length,
      objectKey: signed.objectKey,
      durationMs: 1000,
    }),
  })
  assert.equal(created.status, 201, await created.clone().text())
  const media = (await created.json()) as { mediaId: string; durationMs: number }
  assert.equal(media.durationMs, 1021)
  const saved = await db.execute(
    sql`SELECT object_key FROM message_media WHERE id = ${media.mediaId}`,
  )
  const finalKey = String(saved[0]?.object_key)
  keys.push(finalKey)
  assert(finalKey.startsWith('chat-media-final/'))
  for (const key of [signed.objectKey, finalKey]) {
    const anonymous = await fetch(`${env.S3_PUBLIC_URL}/${key}`)
    assert.equal(anonymous.status, 403, 'chat media must not be anonymously readable')
  }
  const objectPath = `${base}${mediaPath}/${media.mediaId}`
  // Reusing the original signed PUT after creation must not change served bytes.
  assert.equal((await fetch(signed.uploadUrl, { method: 'PUT', body: 'overwritten' })).status, 200)
  const full = await fetch(objectPath, { headers: { Cookie: cookie } })
  assert.equal(full.status, 200)
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), bytes)
  const partial = await fetch(objectPath, { headers: { Cookie: cookie, Range: 'bytes=8-31' } })
  assert.equal(partial.status, 206)
  assert.equal(partial.headers.get('content-range'), `bytes 8-31/${bytes.length}`)
  assert.deepEqual(new Uint8Array(await partial.arrayBuffer()), bytes.slice(8, 32))
  assert.equal(
    (await fetch(objectPath, { headers: { Cookie: cookie, Range: `bytes=${bytes.length}-` } }))
      .status,
    416,
  )
  assert.equal(
    (await fetch(objectPath, { headers: { Cookie: otherCookie, Range: 'bytes=0-1' } })).status,
    404,
  )
  assert.equal((await fetch(objectPath)).status, 401)
  console.log(
    '[media-smoke] ok: fragmented MP4, server duration, immutable snapshot, Range, authorization',
  )
} finally {
  if (api) {
    api.kill()
    await api.exited
  }
  for (const key of keys) await client.delete(key)
  await db.$client.close()
  await admin.$client.unsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`)
  await admin.$client.close()
}
