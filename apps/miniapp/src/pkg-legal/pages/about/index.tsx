import { Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useMemo } from 'react'
import brandMark from '@/assets/brand/brand-mark.png'
import { ICONS } from '@/assets/lib-icons'
import NavBar from '@/components/nav-bar'
import { APP_VERSION } from '@/lib/app-meta'
import { readNavMetrics } from '@/lib/nav-metrics'
import './index.scss'

/**
 * 关于与版本（稿 `小程序1版关于与版本.html`）。
 *
 * ⚠️ **未定内容页面**：本页的**实际页面内容由 zzstar 决策**。稿里明确标为「待定」的两行
 * （软件许可使用协议 / 证照信息）**照稿保留占位**：条目名虚线 + 行尾等宽「待定」，
 * 且**不画箭头**（免得画成能点却没处去的行）。要不要收录、叫什么名字由 zzstar 定；
 * 定了之后把占位换成真的跳转行即可。
 *
 * 形态（稿的形态口径 ①②③，Owner 指定）：
 * - 参照闲鱼「关于」页的骨架：居中品牌区 → 白卡条目列表 → 页脚版权；**不照抄它的条目数量**；
 * - **版本号是纯展示行**：不可点、无箭头、不做「检查更新」。这也与平台能力一致 ——
 *   小程序没有主动触发检查更新的 API（微信只在冷启动时自动检查），
 *   `Taro.getUpdateManager()` 只给回调、没有 `checkNow()`；
 * - 条目行**不加左图标**（一行只放一个信息），只有版本行留图标，用来区分「展示项 / 跳转项」。
 *
 * 版本号取仓内常量 `APP_VERSION`（`@/mock/api`），**不照稿硬写 v1.0.0** ——
 * 稿自己标注了「仓内常量当前为 1.4.0，落地需对齐」，读同一个常量才不会出现
 * 「设置页写 1.4.0、本页写 1.0.0」的两处版本号打架。构建号不展示（设置页页脚已有）。
 *
 * 品牌标记用真实资产 `assets/brand/brand-mark.png`（稿的取舍 ②：稿里那个渐变方块 +
 * 「鱼」字是占位，落地整块换成本图）。页脚版权行取稿的原文（来源
 * `apps/api/src/modules/auth/mail-template.ts` 的那一句）。
 *
 * 入口：我的 →「帮助与设置 → 关于与版本」、设置页「关于 → 关于鱼小应」。
 */
export default function About() {
  /** 顶部让位：本页导航是漂浮层，页头渐变要压到它底下，所以按同一套胶囊栅格顶下去 */
  const navHeight = useMemo(() => readNavMetrics().totalHeight, [])

  /** 条目行：有 `url` 才可点；`待定` 行只画占位与标签 */
  const go = (url: string) => void Taro.navigateTo({ url })

  return (
    <View className="ab">
      <NavBar title="关于鱼小应" titleAlign="center" />

      {/* 品牌区：冰蓝渐变 + 底部圆角，压住漂浮导航 */}
      <View className="ab__brand" style={{ paddingTop: `${navHeight + 8}px` }}>
        <Image className="ab__mark" src={brandMark} mode="aspectFit" />
        <View className="ab__name-row">
          <Text className="ab__name">鱼小应</Text>
          <Text className="ab__name-en">FISH</Text>
        </View>
        <Text className="ab__slogan">广应科校内二手交易平台</Text>
      </View>

      {/* 版本卡：纯展示，不可点、无箭头 */}
      <View className="ab__card">
        <View className="ab__row">
          <View className="ab__row-ic">
            <Image className="ab__row-ic-img" src={ICONS.app} mode="aspectFit" />
          </View>
          <Text className="ab__row-label">版本号</Text>
          <Text className="ab__row-val num">{`v${APP_VERSION}`}</Text>
        </View>
      </View>

      {/* 条目卡：协议与证照 */}
      <View className="ab__card">
        <View className="ab__row is-act" onClick={() => go('/pkg-legal/pages/terms/index')}>
          <Text className="ab__row-label">用户协议</Text>
          <Image className="ab__row-chev" src={ICONS.chevronRightMuted} mode="aspectFit" />
        </View>
        <View className="ab__row is-act" onClick={() => go('/pkg-legal/pages/privacy/index')}>
          <Text className="ab__row-label">隐私政策</Text>
          <Image className="ab__row-chev" src={ICONS.chevronRightMuted} mode="aspectFit" />
        </View>
        {/* 占位条目：条目名与是否收录待 zzstar 定（稿的条目口径 ③） */}
        <View className="ab__row">
          <Text className="ab__row-label">
            <Text className="ab__ph">软件许可使用协议</Text>
          </Text>
          <Text className="ab__row-tag num">待定</Text>
        </View>
        <View className="ab__row">
          <Text className="ab__row-label">
            <Text className="ab__ph">证照信息</Text>
          </Text>
          <Text className="ab__row-tag num">待定</Text>
        </View>
      </View>

      {/* 页脚：版权行（稿取舍 ⑤） */}
      <View className="ab__foot">
        <Text className="ab__foot-copy">Copyright © 鱼小应 2026 All Rights Reserved.</Text>
      </View>
    </View>
  )
}
