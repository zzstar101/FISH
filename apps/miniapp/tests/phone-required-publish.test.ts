import { describe, expect, test } from 'bun:test'
import { isPhoneRequiredError, needsPhoneBeforePublish } from '../src/features/auth/phone'

/**
 * 发布前必须绑定手机号（#514）的端上回归。
 *
 * 两层（同 `sell-lifecycle.test.ts` / `comments-wiring.test.ts` 的口径）：
 * 1. 判据层 —— `features/auth/phone.ts` 的纯函数：新建要挡、编辑不挡、403 形状识别；
 * 2. 接线层 —— 读出物页 / 许愿页源码，断言门禁**先于**创建请求、403 走绑定 sheet、
 *    绑好不自动重发。
 *
 * 边界：接线层只证明源码里有这些语句，不证明运行时（原生 getPhoneNumber 按钮、sheet 的层级与
 * safe-area、toast 时机）。那部分在微信开发者工具里实测，不拿本文件当端上证明。
 */

async function source(path: string): Promise<string> {
  return Bun.file(new URL(`../src/${path}`, import.meta.url)).text()
}

/** 取 `start` 到其后第一次出现的 `end`（含 `end`）之间的片段 */
function sliceFrom(code: string, start: string, end: string): string {
  const from = code.indexOf(start)
  expect(from, `源码里应出现 ${start}`).toBeGreaterThanOrEqual(0)
  const to = code.indexOf(end, from)
  expect(to, `${end} 应出现在 ${start} 之后`).toBeGreaterThanOrEqual(0)
  return code.slice(from, to + end.length)
}

describe('needsPhoneBeforePublish', () => {
  test('新建：未绑定 / 未知都要先绑', () => {
    expect(needsPhoneBeforePublish({ phoneBound: false, editing: false })).toBe(true)
    expect(needsPhoneBeforePublish({ phoneBound: undefined, editing: false })).toBe(true)
  })

  test('新建：已绑定放行', () => {
    expect(needsPhoneBeforePublish({ phoneBound: true, editing: false })).toBe(false)
  })

  test('编辑已有商品不挡（服务端 PATCH 不要求手机号）', () => {
    expect(needsPhoneBeforePublish({ phoneBound: false, editing: true })).toBe(false)
  })
})

describe('isPhoneRequiredError', () => {
  test('只认 403 + PHONE_REQUIRED', () => {
    expect(isPhoneRequiredError({ code: 'PHONE_REQUIRED', status: 403, message: 'x' })).toBe(true)
    expect(isPhoneRequiredError({ code: 'PHONE_REQUIRED', status: 400 })).toBe(false)
    expect(isPhoneRequiredError({ code: 'FORBIDDEN', status: 403 })).toBe(false)
    expect(isPhoneRequiredError(new Error('PHONE_REQUIRED'))).toBe(false)
    expect(isPhoneRequiredError(null)).toBe(false)
  })
})

describe('出物页接线', () => {
  test('新建未绑定：门禁在 createListing 之前，打开 sheet 后直接返回', async () => {
    const code = await source('pages/sell/index.tsx')
    const submit = sliceFrom(code, 'const submit = () => {', '* 冷却倒计时。')
    const gate = submit.indexOf(
      'if (needsPhoneBeforePublish({ phoneBound: user?.phoneBound, editing })) {',
    )
    expect(gate).toBeGreaterThanOrEqual(0)
    expect(gate).toBeLessThan(submit.indexOf('beginTask('))
    expect(gate).toBeLessThan(submit.indexOf('createListing('))
    // 门禁分支只开 sheet + return，不发请求
    const branch = sliceFrom(submit, 'if (needsPhoneBeforePublish(', 'return\n')
    expect(branch).toContain('setPhoneSheetOpen(true)')
    expect(branch).toContain('return')
  })

  test('服务端 403 PHONE_REQUIRED：打开 sheet，不落到 toast', async () => {
    const code = await source('pages/sell/index.tsx')
    const handler = sliceFrom(
      code,
      'const handleSubmitError = (error: unknown) => {',
      'const submit',
    )
    const phone = handler.indexOf('if (isPhoneRequiredError(error)) {')
    expect(phone).toBeGreaterThanOrEqual(0)
    expect(phone).toBeLessThan(handler.indexOf('toast('))
    const branch = sliceFrom(handler, 'if (isPhoneRequiredError(error)) {', '}')
    expect(branch).toContain('setPhoneSheetOpen(true)')
    expect(branch).toContain('return')
  })

  test('绑好：关 sheet + 提示再点一次，不自动重发', async () => {
    const code = await source('pages/sell/index.tsx')
    const bind = sliceFrom(code, 'const phoneBind = usePhoneBind({', '})')
    expect(bind).toContain('onBound: () => setPhoneSheetOpen(false)')
    expect(bind).toContain("boundToast: '手机号已绑定，请再次点击发布'")
    expect(bind).not.toContain('submit')
    expect(code).toContain('<PhoneBindSheet')
  })
})

describe('许愿页接线', () => {
  test('未绑定：门禁在 createWish 之前，打开 sheet 后直接返回', async () => {
    const code = await source('pkg-social/pages/wish-publish/index.tsx')
    const submit = sliceFrom(code, 'const submit = async () => {', 'finally {')
    const gate = submit.indexOf(
      'if (needsPhoneBeforePublish({ phoneBound: user?.phoneBound, editing: false })) {',
    )
    expect(gate).toBeGreaterThanOrEqual(0)
    expect(gate).toBeLessThan(submit.indexOf('submittingRef.current = true'))
    expect(gate).toBeLessThan(submit.indexOf('createWish('))
    const branch = sliceFrom(submit, 'if (needsPhoneBeforePublish(', 'return\n')
    expect(branch).toContain('setPhoneSheetOpen(true)')
    expect(branch).toContain('return')
  })

  test('服务端 403 PHONE_REQUIRED：打开 sheet，其它错误照旧 toast', async () => {
    const code = await source('pkg-social/pages/wish-publish/index.tsx')
    const caught = sliceFrom(code, '} catch (error) {', 'finally {')
    const phone = caught.indexOf('if (isPhoneRequiredError(error)) {')
    expect(phone).toBeGreaterThanOrEqual(0)
    expect(phone).toBeLessThan(caught.indexOf('Taro.showToast('))
    const branch = sliceFrom(caught, 'if (isPhoneRequiredError(error)) {', '}')
    expect(branch).toContain('setPhoneSheetOpen(true)')
    expect(branch).toContain('return')
  })

  test('绑好：关 sheet + 提示再点一次，不自动重发', async () => {
    const code = await source('pkg-social/pages/wish-publish/index.tsx')
    const bind = sliceFrom(code, 'const phoneBind = usePhoneBind({', '})')
    expect(bind).toContain('onBound: () => setPhoneSheetOpen(false)')
    expect(bind).toContain("boundToast: '手机号已绑定，请再次点击发布'")
    expect(bind).not.toContain('submit')
    expect(code).toContain('<PhoneBindSheet')
  })
})
