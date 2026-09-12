import { drizzle } from 'drizzle-orm/bun-sql'

/**
 * Bun 原生 SQL 驱动（bun:sql），不引入 pg / postgres 依赖。
 * Schema 由 #2 建立；本 Issue 只提供连接入口。
 */
export function createDb(databaseUrl: string) {
  return drizzle(databaseUrl)
}

export type Db = ReturnType<typeof createDb>
