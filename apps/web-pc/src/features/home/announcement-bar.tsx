import { Fragment } from 'react'

/**
 * 首页顶部公告 / 广告位。
 *
 * 现在没有广告投放后端，文案是本地维护的运营位——不是从服务端取的业务数据。
 * 将来接真实投放时只替换 `ANNOUNCEMENTS` 的来源，滚动与可访问性逻辑不用动。
 */
const ANNOUNCEMENTS = [
  '发布闲置只要 30 秒：拍照、定价、挂到校内',
  '许愿墙已上线：说出你想要的，等人来匹配',
  '校内面交更安心：全程站内沟通，见面再付款',
] as const

/**
 * 每组重复的遍数：保证单组宽度超过 PC 视口，滚动位移到 50% 时不会露出空档。
 * 只有第一遍对屏幕阅读器可见，其余是纯视觉重复。
 */
const GROUP_ROUNDS = [
  { id: 'lead', decorative: false },
  { id: 'repeat-1', decorative: true },
  { id: 'repeat-2', decorative: true },
] as const

/**
 * 一组公告。滚动轨道里放两组完全相同的副本做无缝循环，
 * 因此只有第一组的第一遍对屏幕阅读器可见，其余都标 `aria-hidden`。
 */
function AnnouncementGroup({ copy }: { copy: boolean }) {
  return (
    <ul className="announcement-group">
      {GROUP_ROUNDS.map((round) => (
        <Fragment key={round.id}>
          {ANNOUNCEMENTS.map((text) => (
            <li
              aria-hidden={copy || round.decorative ? true : undefined}
              className="whitespace-nowrap"
              key={`${round.id}-${text}`}
            >
              {text}
            </li>
          ))}
        </Fragment>
      ))}
    </ul>
  )
}

export function AnnouncementBar() {
  return (
    <section
      aria-label="站内公告"
      // 高度上限 72px，且任何视口下都不超过 20dvh（要求：上下占比 ≤ 20%）。
      className="announcement-bar mb-5 flex h-[min(72px,20dvh)] items-center gap-3 overflow-hidden rounded-2xl border border-line bg-brand-soft focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-2"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: WCAG 2.2.2 要求自动滚动内容有键盘可达的暂停方式；Owner 明确不要按钮，所以让区域本身可聚焦，聚焦即暂停（见 styles.css 的 :focus-within 规则）。
      tabIndex={0}
    >
      <p className="ml-4 shrink-0 rounded-full bg-brand px-3 py-1 font-semibold text-white text-xs">
        公告
      </p>

      <div className="announcement-viewport min-w-0 flex-1 overflow-hidden">
        <div className="announcement-track">
          <AnnouncementGroup copy={false} />
          <AnnouncementGroup copy />
        </div>
      </div>
    </section>
  )
}
