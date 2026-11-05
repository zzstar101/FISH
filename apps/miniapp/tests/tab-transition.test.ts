import { describe, expect, test } from 'bun:test'
import { createTabTransition } from '../src/lib/tab-transition'

const home = 'pages/home/index'
const wish = 'pages/wish/index'
const chat = 'pages/chat/index'
const profile = 'pages/profile/index'

// 控制时间，不依赖真实 timer 或微信运行时；实际路由始终由 onShow 提供。
describe('Tab 过渡意图', () => {
  test('只有显式切换且目标 onShow 到达后才产生动画，首次/重复显示不重播', () => {
    const transition = createTabTransition()
    expect(transition.arrive(home, 0)).toBeNull()
    transition.begin(home, wish, 10)
    expect(transition.read(wish, 10)).toBeNull()
    const motion = transition.arrive(wish, 30)
    expect(motion).toMatchObject({ from: 0, to: 130.8, route: wish, startedAt: 30 })
    expect(transition.read(home, 40)).toBeNull()
    expect(transition.read(wish, 40)).toEqual(motion)
    expect(transition.arrive(wish, 50)).toBeNull()
  })

  test('快速反向从当前曲线位置续接，不从上一个逻辑槽位跳起', () => {
    const transition = createTabTransition()
    transition.begin(home, profile, 0)
    const first = transition.arrive(profile, 0)
    expect(first).not.toBeNull()
    transition.begin(profile, wish, 30)
    // easeOutCubic 在半程时到达 87.5%；导航期间原动效继续，不在点击时冻结。
    const next = transition.arrive(wish, 80)
    expect(next?.from).toBeCloseTo(523.2 * 0.875, 4)
    expect(next?.to).toBe(130.8)
    expect(next?.id).not.toBe(first?.id)
    expect(transition.read(profile, 80)).toBeNull()
    expect(transition.read(wish, 240)).toBeNull()
  })

  test('只消费最新意图，旧导航的失败回调不能清掉新意图', () => {
    const transition = createTabTransition()
    const oldId = transition.begin(home, wish, 0)
    transition.begin(home, chat, 10)
    transition.cancel(oldId)
    expect(transition.arrive(chat, 20)?.to).toBeCloseTo(392.4)
  })

  test('失败导航不改变可见状态，也不向后续显示泄漏动效', () => {
    const transition = createTabTransition()
    const id = transition.begin(home, wish, 0)
    transition.cancel(id)
    expect(transition.arrive(wish, 10)).toBeNull()
    expect(transition.read(wish, 10)).toBeNull()
  })

  test('超时或路由不匹配时立即落到实际路由，不排队等待', () => {
    const transition = createTabTransition()
    transition.begin(home, wish, 0)
    expect(transition.arrive(wish, 1000)).toBeNull()
    transition.begin(wish, chat, 1100)
    expect(transition.arrive(profile, 1110)).toBeNull()
    expect(transition.arrive(chat, 1120)).toBeNull()
  })

  test('后台/页面卸载 reset 后，reLaunch 不能沿用旧意图或动画', () => {
    const transition = createTabTransition()
    transition.begin(home, wish, 0)
    transition.arrive(wish, 10)
    transition.begin(wish, chat, 20)
    transition.reset()
    expect(transition.read(wish, 30)).toBeNull()
    expect(transition.arrive(chat, 30)).toBeNull()
    transition.begin(chat, home, 40)
    expect(transition.arrive(home, 50)?.from).toBeCloseTo(392.4)
  })

  test('出物、非 Tab 与同页点击不参与动效，且会废弃旧意图', () => {
    const transition = createTabTransition()
    for (const [from, to] of [
      [home, 'pages/sell/index'],
      ['pages/sell/index', home],
      [home, 'pkg-browse/pages/listing-detail/index'],
      [wish, wish],
    ]) {
      transition.begin(home, profile, 0)
      transition.begin(from ?? '', to ?? '', 10)
      expect(transition.arrive(to ?? '', 20)).toBeNull()
      expect(transition.arrive(profile, 30)).toBeNull()
    }
  })
})
