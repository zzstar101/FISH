/**
 * 扫码家族的三段纯文字切换钮（扫一扫 / 识图 / 交易码）。
 *
 * 取景框正下方一行三等分：激活项白色高亮、其余压灰，无胶囊容器。
 * 跳转行为在 `tabs.ts`（可单测），本组件只消费它的结果；redirect 用
 * `redirectTo` 替换当前页，保证两个扫码页来回切不会把页面栈堆满。
 */
import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { SCAN_TABS, type ScanTabKey, scanTabAction } from './tabs'
import './index.scss'

type ScanTabsProps = {
  /** 当前页对应的 tab；点它不动作 */
  active: ScanTabKey
}

export default function ScanTabs({ active }: ScanTabsProps) {
  const handleTap = (key: ScanTabKey) => {
    const action = scanTabAction(key, active)
    if (!action) return
    if (action.kind === 'toast') {
      void Taro.showToast({ title: action.title, icon: 'none' })
      return
    }
    void Taro.redirectTo({ url: action.url }).catch(() => {
      // 页面栈满等导航失败：留在本页并给反馈，不静默吞掉
      void Taro.showToast({ title: '页面打开失败，请重试', icon: 'none' })
    })
  }

  return (
    <View className="scantabs">
      {SCAN_TABS.map((tab) => (
        <View
          key={tab.key}
          className={`scantabs__item${tab.key === active ? ' is-active' : ''}`}
          onClick={() => handleTap(tab.key)}
        >
          <Text>{tab.label}</Text>
        </View>
      ))}
    </View>
  )
}
