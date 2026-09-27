import { describe, expect, test } from 'bun:test'
import { AREAS, computeFlags, toGitHubOutputs } from './ci-changes'

const derived = (files: string[]) => {
  const { areas, ...rest } = computeFlags(files)
  return { ...rest, areas }
}

describe('computeFlags', () => {
  test('纯文档改动什么都不跑', () => {
    const flags = derived([
      'docs/architecture.md',
      'README.md',
      'AGENTS.md',
      'CONTRIBUTING.md',
      'docs/design/issue-147-transaction-invariants.md',
    ])
    expect(flags).toMatchObject({
      full: false,
      static: false,
      dbTests: false,
      unitTests: false,
      webPc: false,
      smoke: false,
    })
    for (const area of AREAS) expect(flags.areas[area]).toBe(false)
  })

  test('非 workflow 的 .github 文件（PR 模板）也不跑 CI', () => {
    expect(computed('.github/pull_request_template.md').static).toBe(false)
  })

  test('改 apps/api：跑 DB 测试与 core smoke，不跑 unit 与 web-pc', () => {
    const flags = computed('apps/api/src/modules/listings/store.ts')
    expect(flags).toMatchObject({
      full: false,
      static: true,
      dbTests: true,
      unitTests: false,
      webPc: false,
      smoke: true,
    })
    expect(flags.areas.api).toBe(true)
    expect(flags.areas.worker).toBe(false)
    expect(flags.areas.db).toBe(false)
  })

  test('apps/web-pc 不会被当成 apps/web', () => {
    const flags = computed('apps/web-pc/src/main.tsx')
    expect(flags.areas.web_pc).toBe(true)
    expect(flags.areas.web).toBe(false)
    expect(flags).toMatchObject({ webPc: true, unitTests: true, dbTests: false, smoke: false })
  })

  test('改 apps/worker：需要 Postgres 的测试与 core smoke，但不跑 unit', () => {
    const flags = computed('apps/worker/src/jobs/matching/engine.ts')
    expect(flags).toMatchObject({ dbTests: true, unitTests: false, smoke: true, webPc: false })
    expect(flags.areas.worker).toBe(true)
    expect(flags.areas.api).toBe(false)
  })

  test('packages/db 改动传递到服务端（api / worker），不传递到前端', () => {
    const flags = computed('packages/db/src/schema/listings.ts')
    expect(flags.areas.db).toBe(true)
    expect(flags.areas.api).toBe(true)
    expect(flags.areas.worker).toBe(true)
    expect(flags.areas.web).toBe(false)
    expect(flags.areas.miniapp).toBe(false)
    expect(flags).toMatchObject({ dbTests: true, unitTests: false, smoke: true })
  })

  test('共享包（contracts / shared / ui）改动传递到全部 app', () => {
    for (const file of [
      'packages/contracts/src/listings/schema.ts',
      'packages/shared/src/format.ts',
      'packages/ui/src/button.tsx',
    ]) {
      const flags = computed(file)
      expect(flags.areas.api).toBe(true)
      expect(flags.areas.worker).toBe(true)
      expect(flags.areas.web).toBe(true)
      expect(flags.areas.web_pc).toBe(true)
      expect(flags.areas.miniapp).toBe(true)
      expect(flags).toMatchObject({ dbTests: true, unitTests: true, webPc: true, smoke: true })
    }
  })

  test('CI 自身、开发脚本、基础设施、根级构建基座、认不出的路径 → 全量', () => {
    for (const file of [
      '.github/workflows/ci.yml',
      'scripts/ci-changes.ts',
      'infra/minio-public-policy.json',
      'package.json',
      'bun.lock',
      'biome.json',
      'tsconfig.json',
      'docker-compose.yml',
      'brand-new-root-file.toml',
    ]) {
      const flags = computed(file)
      expect(flags.full).toBe(true)
      expect(flags.static).toBe(true)
      for (const area of AREAS) expect(flags.areas[area]).toBe(true)
    }
  })

  test('全量时所有派生标志都为 true', () => {
    const flags = computeFlags([], { full: true })
    expect(flags).toMatchObject({
      full: true,
      static: true,
      dbTests: true,
      unitTests: true,
      webPc: true,
      smoke: true,
    })
  })

  test('空文件列表本身不算改动（CLI 在没有范围参数时会显式按全量）', () => {
    expect(computeFlags([]).static).toBe(false)
  })

  test('多个改动取并集', () => {
    const flags = computeFlags([
      'apps/web-pc/src/main.tsx',
      'apps/miniapp/src/pages/home/index.tsx',
    ])
    expect(flags.areas.web_pc).toBe(true)
    expect(flags.areas.miniapp).toBe(true)
    expect(flags.areas.api).toBe(false)
  })
})

describe('toGitHubOutputs', () => {
  test('覆盖全部 key 且都是 key=value', () => {
    const lines = toGitHubOutputs(computeFlags(['apps/api/src/app.ts'])).split('\n')
    const keys = lines.map((line) => line.split('=')[0])
    expect(keys).toEqual([
      ...new Set(['full', 'static', 'db_tests', 'unit_tests', 'web_pc', 'smoke', ...AREAS]),
    ])
    for (const line of lines) expect(line).toMatch(/^[a-z_]+=(true|false)$/)
  })
})

function computed(file: string) {
  return computeFlags([file])
}
