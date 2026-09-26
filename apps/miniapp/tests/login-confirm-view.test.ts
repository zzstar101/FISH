import { describe, expect, test } from 'bun:test'
import { parseLoginLaunch } from '../src/pages/login-confirm/view'

/**
 * 扫码登录确认页的启动参数解析。
 *
 * `ticket` 显式参数是演示与页内跳转的入口；`scene`（解码后 `t=<ticket>`）是
 * 小程序码直拉本页的入口 —— 该形状是临时约定，#197 冻结契约后以契约为准。
 * 取不到票号必须落「无效登录码」态，不能拿空票去确认。
 */

describe('parseLoginLaunch', () => {
  test('显式 ticket 参数直达', () => {
    expect(parseLoginLaunch({ ticket: 'tk_abc123' })).toEqual({ ticket: 'tk_abc123' })
  })

  test('显式 ticket 只差空白时修剪，纯空白视为缺失', () => {
    expect(parseLoginLaunch({ ticket: '  tk_1  ' })).toEqual({ ticket: 'tk_1' })
    expect(parseLoginLaunch({ ticket: '   ' })).toBeNull()
  })

  test('scene：百分号编码与原样的 t= 都解析', () => {
    expect(parseLoginLaunch({ scene: 't%3Dtk_abc' })).toEqual({ ticket: 'tk_abc' })
    expect(parseLoginLaunch({ scene: 't=tk_abc' })).toEqual({ ticket: 'tk_abc' })
  })

  test('scene：非 t= 形状 / 空票号返回 null', () => {
    expect(parseLoginLaunch({ scene: 'hello' })).toBeNull()
    expect(parseLoginLaunch({ scene: 't%3D' })).toBeNull()
    expect(parseLoginLaunch({ scene: 't=%20%20' })).toBeNull()
  })

  test('两个入口都没有时返回 null', () => {
    expect(parseLoginLaunch({})).toBeNull()
    expect(parseLoginLaunch({ other: 'x' })).toBeNull()
  })
})
