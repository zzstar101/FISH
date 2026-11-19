import { expect, test } from 'bun:test'
import { SCAN_CONFIRM_PAGE } from '@fish/contracts/auth/scan'

/**
 * 契约里的扫码确认页路径必须落在真实页面上：`SCAN_CONFIRM_PAGE` 会原样作为
 * `getUnlimitedQRCode` 的 `page` 出码，写错时微信只在用户扫码后才报「页面不存在」，
 * 服务端出码阶段（trial 的 `check_path=false`）不会拦住。
 *
 * 回归背景：页面从 `pages/login-confirm/index` 拆进 `pkg-auth` 分包后，契约常量
 * 没有跟着改，线上扫码全部落到不存在的页面。
 */
test('SCAN_CONFIRM_PAGE 指向小程序里真实存在的页面', async () => {
  const page = Bun.file(new URL(`../src/${SCAN_CONFIRM_PAGE}.tsx`, import.meta.url))
  expect(await page.exists()).toBe(true)
})
