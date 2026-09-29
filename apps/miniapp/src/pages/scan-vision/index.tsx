import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useMemo, useState } from 'react'
import ScanTabs from '@/components/scan-tabs'
import { startVisualSearch } from '@/features/visual-search/start'
import { readNavMetrics } from '@/lib/nav-metrics'
import './index.scss'

/**
 * 识图（拍照找同款）—— 扫码家族第三段 tab 的落点页。
 *
 * 本页只做**入口 + 取图**：检索与结果渲染在结果页
 * （`pages/vision-result`，见 `features/visual-search/link.ts`）：
 *
 * ```text
 * 点主按钮 → 来源弹窗（拍摄 / 从相册选择 / 从聊天会话选择）
 *   → 微信原生取图面板 → 本地校验（后缀 mime + 大小）
 *   → 上传查询图（presign → 直传）→ 跳识图结果页
 * ```
 *
 * **为什么取图走原生面板而不是自建取景框**：扫码家族另外两页的取景框是给「连续识别」用的，
 * 识图是一次性取图 —— 原生取图面板自带压缩（`sizeType: ['compressed']`）与权限流程，
 * 比自建取景少一整条权限 / 错误分支，也不会多一份与 `pages/scan` 重复的取景样式。
 * 三个来源的分派与整条链见 `features/visual-search/start.ts`（搜索页的识图按钮共用它）。
 *
 * **失败口径**：取图取消 → 静默返回；本地校验被挡 → 说明原因；其余失败 → 一句 toast
 * （文案见 `features/visual-search/messages.ts`，429 会带上剩余秒数）。
 *
 * 本页不缓存待搜索的图：查询图是「这一次识别」的输入，用户回来再拍就该重新上传
 * （对象键按主体 + 新 fileId 派生）。
 */
export default function ScanVision() {
  /** 上传在途：按钮防连点（原生取图面板本身是模态的，上传腿不是） */
  const [busy, setBusy] = useState(false)

  // 返回钮与标题的垂直位置跟微信原生胶囊对齐（设备 px，内联下发，不参与 rpx 缩放）
  const nav = useMemo(() => readNavMetrics(), [])

  const goBack = () => {
    const pages = Taro.getCurrentPages()
    if (pages.length > 1) void Taro.navigateBack()
    else void Taro.switchTab({ url: '/pages/home/index' })
  }

  const startSearch = async () => {
    if (busy) return
    setBusy(true)
    try {
      await startVisualSearch()
    } finally {
      setBusy(false)
    }
  }

  return (
    <View className="scanvis">
      {/* ---------------- 顶部：返回 + 标题（对齐右侧微信原生胶囊的中线） ---------------- */}
      <View
        className="scanvis__back"
        style={{ top: `${nav.statusBarHeight + nav.contentHeight / 2}px` }}
        onClick={goBack}
      >
        <View className="scanvis__back-chevron" />
      </View>
      <Text
        className="scanvis__title"
        style={{ top: `${nav.statusBarHeight + nav.contentHeight / 2}px` }}
      >
        识图
      </Text>

      {/* ---------------- 取图提示框（不承载相机：取图走原生面板） ---------------- */}
      <View className="scanvis__frame">
        <View className="scanvis__cnr scanvis__cnr--tl" />
        <View className="scanvis__cnr scanvis__cnr--tr" />
        <View className="scanvis__cnr scanvis__cnr--bl" />
        <View className="scanvis__cnr scanvis__cnr--br" />
        <Text className="scanvis__frame-hint">拍一张商品照片</Text>
      </View>

      <Text className="scanvis__lead">教材、数码、服饰……都能拍图找同款</Text>

      <View className={`scanvis__cta${busy ? ' is-busy' : ''}`} onClick={() => void startSearch()}>
        <Text>{busy ? '正在上传…' : '拍照 / 选图识图'}</Text>
      </View>

      {/* 数据出域与保留口径：查询图存私有前缀（不公开），识别会把图发给第三方模型服务 */}
      <View className="scanvis__notes">
        <Text className="scanvis__note">图片仅用于本次识别，存私有空间、不公开展示</Text>
        <Text className="scanvis__note">识别由第三方模型服务完成（图片会上传至该服务）</Text>
      </View>

      {/* ---------------- 底部：扫码家族切换钮 ---------------- */}
      <ScanTabs active="vision" />
    </View>
  )
}
