import { afterAll, describe, expect, test } from 'bun:test'
import {
  buildListingEmbeddingText,
  buildWishEmbeddingText,
  contentHashOf,
} from '@fish/contracts/embedding/text'
import { createDb } from '@fish/db/client'
import { sql } from 'drizzle-orm'
import { embeddingContentHashSql } from './content-hash-sql'

// 与 packages/db 的集成测试同一约定：没有 DATABASE_URL 就明确失败，而不是静默跳过。
// 本文件只需要一个能跑 `sha256()` / `btrim()` 的连接，**不建任何业务行**（用 `VALUES` 当行源）。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)

afterAll(async () => {
  await db.$client.close()
})

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  const rows = (result as { rows?: unknown }).rows
  return Array.isArray(rows) ? (rows as T[]) : []
}

/** 三个字段的**列顺序**必须与 `embeddingContentHashSql()` 读的列一致（listing: title/…；wish: keyword/…）。 */
const COLUMNS = {
  listing: sql.raw('title, description, category'),
  wish: sql.raw('keyword, description, category'),
} as const

type Case = {
  name: string
  primary: string
  description: string | null
  category: string | null
}

/** 用 `VALUES` 造一行（不落库），让 SQL 侧的指纹与 TS 侧的 `contentHashOf()` 直接对拍。 */
async function sqlHash(kind: 'listing' | 'wish', row: Case): Promise<string> {
  const rows = rowsOf<{ hash: string }>(
    await db.execute(sql`
      SELECT ${embeddingContentHashSql(kind, sql`v`)} AS hash
      FROM (VALUES (${row.primary}::text, ${row.description}::text, ${row.category}::text))
        AS v(${COLUMNS[kind]})
    `),
  )
  return rows[0]?.hash ?? ''
}

function expected(kind: 'listing' | 'wish', row: Case): string {
  const text =
    kind === 'listing'
      ? buildListingEmbeddingText({
          title: row.primary,
          description: row.description,
          category: row.category,
        })
      : buildWishEmbeddingText({
          keyword: row.primary,
          description: row.description,
          category: row.category,
        })
  return contentHashOf(text)
}

/**
 * 边界值清单：这些是 `normalizeValue()` / `compose()` 里最容易两边算出不同文本的地方
 * （JS `trim()` 的白空格集合比 Postgres `btrim(x)` 默认值大得多；空字段要整行省略）。
 */
const LISTING_CASES: Case[] = [
  { name: '普通值', primary: '二手键盘', description: '九成新', category: '电子数码' },
  {
    name: '首尾空白（空格 / 制表符）',
    primary: '  二手键盘  ',
    description: '\t九成新\t',
    category: '电子数码',
  },
  {
    name: 'CRLF 与孤立 CR 都归一成 LF',
    primary: '二手\r\n键盘',
    description: '第一行\r第二行',
    category: '电子数码',
  },
  { name: '空串字段整行省略', primary: '二手键盘', description: '', category: '   ' },
  {
    name: '全角空格与 NBSP',
    primary: '\u3000二手键盘\u00a0',
    description: '\u00a0\u3000',
    category: '电子数码',
  },
  {
    name: '垂直制表 / 换页 / 行分隔符',
    primary: '\v\f\u2028二手\u2029',
    description: '\u2028行\u2029',
    category: '电子数码',
  },
  {
    name: 'emoji（代理对按 UTF-8 编码）',
    primary: '二手键盘🎹',
    description: '🎵 九成新',
    category: '电子数码',
  },
  {
    name: '多行描述（LF 保留在值内部）',
    primary: '二手键盘',
    description: '第一行\n第二行\n第三行',
    category: '电子数码',
  },
]

const WISH_CASES: Case[] = [
  {
    name: '分类为 null → 写成「不限」',
    primary: '求一个机械键盘',
    description: null,
    category: null,
  },
  { name: '普通值', primary: '求一个机械键盘', description: '预算 200 以内', category: '电子数码' },
  { name: '分类为空串 → 整行省略', primary: '求一个机械键盘', description: '', category: '' },
  {
    name: '分类只有全角空格 → 整行省略',
    primary: '求一个键盘',
    description: null,
    category: '\u3000',
  },
  { name: '描述含 CRLF', primary: '求键盘', description: '要求：\r\n无磕碰', category: '电子数码' },
]

describe('SQL 侧内容指纹复刻（#322 M4：obs 覆盖率补 contentHash 腿）', () => {
  for (const row of LISTING_CASES) {
    test(`listing：${row.name}`, async () => {
      expect(await sqlHash('listing', row)).toBe(expected('listing', row))
    })
  }

  for (const row of WISH_CASES) {
    test(`wish：${row.name}`, async () => {
      expect(await sqlHash('wish', row)).toBe(expected('wish', row))
    })
  }

  test('内容变了指纹就变（不是恒等函数）', async () => {
    const base: Case = {
      name: '',
      primary: '二手键盘',
      description: '九成新',
      category: '电子数码',
    }
    const changed: Case = { ...base, primary: '二手键盘（已售）' }
    expect(await sqlHash('listing', base)).not.toBe(await sqlHash('listing', changed))
    expect(await sqlHash('listing', changed)).toBe(expected('listing', changed))
  })
})
