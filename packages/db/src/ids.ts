/**
 * 主键生成：#2 冻结为 UUIDv7（时间有序），在应用侧生成。
 *
 * PG16 没有内置 uuidv7，本地镜像也没有 pg_uuidv7 扩展；写入方只有 API / Worker / seed，
 * 全部经 Drizzle，因此统一在这里生成，不设 DB 级 default。
 */
export function newId(): string {
  return Bun.randomUUIDv7()
}
