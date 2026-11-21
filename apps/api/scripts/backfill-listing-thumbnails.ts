/**
 * 列表缩略图回填（#620）。
 *
 * 背景：`confirm` 会为**新上传**的公开图片同时写一份缩略图对象，但本 Issue 上线前已经固化在
 * `listings/{usr}/{med}.{ext}` 下的历史图片没有。列表/卡片的 `coverUrl` 无条件指向缩略图键，
 * 所以发布时必须先把历史图片补齐，否则这些商品在列表里会显示为空白封面。
 *
 * 数据源是「商品图片 ∪ 上传台账的公开 final 键」：只扫 `listing_images` 会漏掉
 * **部署前已 confirm、部署后才被挂到商品上**的图片 —— 这类图片走 `confirm` 的幂等重放
 * （`reuse()` 快路径，不重新渲染缩略图），上线时又不在任何图片组里，于是列表封面永久 404。
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
import { listingMediaObjects } from '@fish/db/schema/listing-media'
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
const [imageRows, mediaRows] = await Promise.all([
  db.selectDistinct({ objectKey: listingImages.objectKey }).from(listingImages),
  // 台账里的 `final_key` 是 confirm 固化出的键（BLOCK 为 NULL）。其中一部分还没被任何商品引用，
  // 但随时可能被 `reuse()` 挂上去，所以也要补齐。
  db.selectDistinct({ finalKey: listingMediaObjects.finalKey }).from(listingMediaObjects),
])
// 审核中的私有键（`listing-review-media/…`）、legacy UUID 键都不在公开前缀下：它们要么由人工放行
// 结算时生成缩略图，要么根本没有缩略图（读地址走原代理），这里只处理规范公开键。
const keys = [
  ...new Set([...imageRows.map((row) => row.objectKey), ...mediaRows.map((row) => row.finalKey)]),
]
  .filter((key): key is string => key !== null && isPublicListingKey(key))
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
    // 原图本身就不在桶里（历史脏数据）时不报缺失：回填也修不了它，且这在上线前就是坏图，
    // 不该让它把发布卡在停机窗口里。
    if (await storage.stat(key)) failures.push({ key, reason: '缩略图缺失' })
    else missingSource += 1
  } else {
    const source = await readMediaBytes(key, MAX_IMAGE_BYTES)
    if (!source || source.byteLength === 0) {
      missingSource += 1
      console.warn(`  ! ${key}：原图对象缺失或为空，跳过（商品图本来就是坏的）`)
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
    `原图缺失 ${missingSource}（跳过），失败/缺失 ${failures.length}`,
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
