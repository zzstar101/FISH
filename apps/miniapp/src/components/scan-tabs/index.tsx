/**
 * 扫码页底部的两段纯文字 tab（扫一扫 / 拍图搜）。
 *
 * #583：**页内状态**，不再 `redirectTo` 兄弟页 —— 当前 tab 由页面持有，点别的 tab 只回调
 * `onChange`，相机模式的切换（`scanCode` ↔ `normal`）由页面换 key 重挂完成。
 * 激活项白色加粗、其余压灰；文字统一带阴影，亮场景（白桌面 / 亮屏）也读得清。
 */
import { Text, View } from '@tarojs/components'
import { SCAN_TABS, type ScanTabKey } from './tabs'
import './index.scss'

type ScanTabsProps = {
  /** 当前 tab；点它不动作 */
  active: ScanTabKey
  onChange: (next: ScanTabKey) => void
}

export default function ScanTabs({ active, onChange }: ScanTabsProps) {
  return (
    <View className="scantabs">
      {SCAN_TABS.map((tab) => (
        <View
          key={tab.key}
          className={`scantabs__item${tab.key === active ? ' is-active' : ''}`}
          onClick={() => {
            if (tab.key !== active) onChange(tab.key)
          }}
        >
          <Text>{tab.label}</Text>
        </View>
      ))}
    </View>
  )
}
