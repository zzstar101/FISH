/**
 * 列表缩略图回填（#620）。
 *
 * 背景：`confirm` 会为**新上传**的公开图片同时写一份缩略图对象，但本 Issue 上线前已经固化在
 * `listings/{usr}/{med}.{ext}` 下的历史图片没有。列表/卡片的 `coverUrl` 无条件指向缩略图键，
 * 所以发布时必须先把历史图片补齐，否则这些商品在列表里会显示为空白封面。
 *
 * 用法（配置留在 .env 里，不落命令行）：
 *
 *   # 只检查差多少，不写任何对象；有缺失时退出码 1（可放进发布前的手工 checklist）
 *   bun --env-file=.env apps/api/scripts/backfill-listing-thumbnails.ts --check
 *
 *   # 实际生成缺失的缩略图
 *   bun --env-file=.env apps/api/scripts/backfill-listing-thumbnails.ts
 *
 * 脚本是**幂等**的：已存在的缩略图直接跳过，所以可以在任意时刻重复执行；生成失败的对象会在
 * 下一次运行时重试。部署顺序见 `docs/deployment.md`「列表缩略图回填」：rsync → 回填 → 重启 API。
 */

import { MAX_IMAGE_BYTES } from '@fish/contracts/listings/schema'
import { createDb } from '@fish/db/client'
import { listingImages } from '@fish/db/schema/listings'
import { loadServerEnv } from '@fish/shared/env'
import { writeListingThumbnail } from '../src/modules/uploads/listing-thumbnail'
import {
  createBunS3MediaStorage,
  isPublicListingKey,
  listingThumbnailKeyOf,
} from '../src/modules/uploads/storage'

const env = loadServerEnv()
const db = createDb(env.DATABASE_URL)
const storage = createBunS3MediaStorage({
  client: new Bun.S3Client({
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    bucket: env.S3_BUCKET,
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    virtualHostedStyle: env.S3_VIRTUAL_HOSTED_STYLE,
  }),
  publicUrlBase: env.S3_PUBLIC_URL,
})
if (!storage.readMediaBytes || !storage.writeMediaBytes) {
  throw new Error('媒体存储未实现字节读写，无法回填缩略图')
}
const readMediaBytes = storage.readMediaBytes

const checkOnly = process.argv.includes('--check')
const rows = await db.selectDistinct({ objectKey: listingImages.objectKey }).from(listingImages)
// 审核中的私有键（`listing-review-media/…`）、legacy UUID 键都不在公开前缀下：它们要么由人工放行
// 结算时生成缩略图，要么根本没有缩略图（读地址走原代理），这里只处理规范公开键。
const keys = rows
  .map((row) => row.objectKey)
  .filter((key) => isPublicListingKey(key))
  .sort()

let existing = 0
let written = 0
let missingSource = 0
const failures: { key: string; reason: string }[] = []

for (const [index, key] of keys.entries()) {
  const thumbnailKey = listingThumbnailKeyOf(key)
  if (!thumbnailKey) continue // 理论不可达：上面已经过滤过 `isPublicListingKey`
  if (await storage.stat(thumbnailKey)) {
    existing += 1
  } else if (checkOnly) {
    failures.push({ key, reason: '缩略图缺失' })
  } else {
    const source = await readMediaBytes(key, MAX_IMAGE_BYTES)
    if (!source || source.byteLength === 0) {
      missingSource += 1
      failures.push({ key, reason: '原图对象缺失或为空' })
    } else {
      try {
        await writeListingThumbnail(storage, key, source)
        written += 1
      } catch (error) {
        failures.push({ key, reason: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  const done = index + 1
  if (done % 25 === 0 || done === keys.length) {
    console.log(`[thumbnails] ${done}/${keys.length}（新生成 ${written}，已存在 ${existing}）`)
  }
}

console.log(
  `[thumbnails] 公开图片 ${keys.length} 张：已存在 ${existing}，新生成 ${written}，` +
    `原图缺失 ${missingSource}，失败/缺失 ${failures.length}`,
)
if (failures.length > 0) {
  for (const failure of failures.slice(0, 20)) {
    console.error(`  ✗ ${failure.key}：${failure.reason}`)
  }
  if (failures.length > 20) console.error(`  … 另有 ${failures.length - 20} 条`)
  console.error(
    checkOnly
      ? '[thumbnails] 仍有缺失：先跑一次不带 --check 的回填，再重新检查'
      : '[thumbnails] 存在失败项：可重复执行本脚本重试',
  )
  process.exit(1)
}
console.log('[thumbnails] 全部就绪')
