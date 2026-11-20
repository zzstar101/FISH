import { describe, expect, test } from 'bun:test'
import { BANNERS, canAutoPlayBanner } from '../src/pages/home/banners'

const homePage = new URL('../src/pages/home/index.tsx', import.meta.url)

describe('首页轮播', () => {
  test('三张独立插画按约定排列', () => {
    expect(BANNERS.map((banner) => banner.title)).toEqual([
      '校园闲置交换站',
      '教材交换',
      '宿舍好物',
    ])
    expect(new Set(BANNERS.map((banner) => banner.image)).size).toBe(3)
  })

  test('只在首页与轮播都可见，且用户未手动切换时自动播放', () => {
    expect(canAutoPlayBanner(true, true, false)).toBe(true)
    expect(canAutoPlayBanner(false, true, false)).toBe(false)
    expect(canAutoPlayBanner(true, false, false)).toBe(false)
    expect(canAutoPlayBanner(true, true, true)).toBe(false)
  })

  test('轮播首屏只展示当前插画，不露出相邻插画', async () => {
    const page = await Bun.file(homePage).text()
    const swiper = page.slice(page.indexOf('<Swiper'), page.indexOf('</Swiper>'))

    expect(swiper).toContain('className="home__banner-swiper"')
    expect(swiper).not.toMatch(/\b(?:displayMultipleItems|previousMargin|nextMargin)\s*=/)
  })

  test('滑动与指示点都同步轮播状态，手动切换后暂停自动播放', async () => {
    const source = (await Bun.file(homePage).text()).replace(/\/\*[\s\S]*?\*\//g, '')
    const swiper = source.slice(source.indexOf('<Swiper'), source.indexOf('</Swiper>'))
    const dots = source.slice(
      source.indexOf('className="home__banner-dots"'),
      source.indexOf('className="home__cats-wrap"'),
    )

    expect(swiper).toContain('current={bannerIndex}')
    expect(swiper).toContain(
      'autoplay={canAutoPlayBanner(bannerPageVisible, bannerInView, bannerManuallyChanged)}',
    )
    expect(swiper).toContain('onChange={({ detail }) => {')
    expect(swiper).toContain('setBannerIndex(detail.current)')
    expect(swiper).toContain("if (detail.source === 'touch') setBannerManuallyChanged(true)")
    expect(dots).toContain('setBannerManuallyChanged(true)')
    expect(dots).toContain('setBannerIndex(index)')
    expect(dots).toContain("index === bannerIndex ? '，当前图片' : ''")
  })
})
