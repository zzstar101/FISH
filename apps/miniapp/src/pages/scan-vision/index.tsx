import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useMemo, useState } from 'react'
import ScanTabs from '@/components/scan-tabs'
import { pickPhotos } from '@/features/upload/api'
import { uploadVisualQueryImage, visualSearchErrorMessage } from '@/features/visual-search/api'
import { visualSearchPageUrl } from '@/features/visual-search/link'
import { readNavMetrics } from '@/lib/nav-metrics'
import './index.scss'

/**
 * 识图（拍照找同款）—— 扫码家族第三段 tab 的落点页。
 *
 * 本页只做**入口 + 查询图上传**，检索与结果渲染在搜索页
 * （`pages/search/index` 消费 `visualObjectKey`，见 `features/visual-search/link.ts`）：
 *
 * ```text
 * 点主按钮 → chooseMedia（拍照 / 相册，原生面板）
 *   → 本地校验（后缀 mime + 大小）→ 上传查询图（presign → 直传）
 *   → navigateTo /pages/search/index?visualObjectKey=…
 * ```
 *
 * **为什么不自己挂 `<Camera>`**：扫码家族另外两页的取景框是给「连续识别」用的，识图是一次性
 * 取图 —— `chooseMedia` 的原生面板同时覆盖拍照与相册、自带压缩（`sizeType: ['compressed']`）
 * 与权限流程（`features/upload/api.ts`），比自建取景少一整条权限/错误分支，也不会多一份
 * 与 `pages/scan` 重复的取景样式。
 *
 * **失败口径**：选图取消 → 静默返回；本地校验被挡 → 说明原因（`pickPhotos` 的 `rejected`）；
 * 其余失败 → 一句 toast（文案见 `features/visual-search/messages.ts`，429 会带上剩余秒数）。
 *
 * 本页不缓存待搜索的图：查询图是「这一次识别」的输入，用户回来再拍就该重新上传
 * （对象键按主体 + 新 fileId 派生，服务端不认第二次使用同一个键的旧图）。
 */
export default function ScanVision() {
  /** 上传在途：按钮防连点（`chooseMedia` 面板本身是模态的，上传腿不是） */
  const [busy, setBusy] = useState(false)

  // 返回钮与标题的垂直位置跟微信原生胶囊对齐（设备 px，内联下发，不参与 rpx 缩放）
  const nav = useMemo(() => readNavMetrics(), [])

  const goBack = () => {
    const pages = Taro.getCurrentPages()
    if (pages.length > 1) void Taro.navigateBack()
    else void Taro.switchTab({ url: '/pages/home/index' })
  }

  const startSearch = async () => {
    setBusy(true)
    let loading = false
    try {
      const { photos, rejected } = await pickPhotos(1)
      if (photos.length === 0) {
        // 空结果只有两种：用户取消（静默）与本地校验挡下（说明原因）
        if (rejected !== null) void Taro.showToast({ title: rejected, icon: 'none' })
        return
      }
      const photo = photos[0]
      if (photo === undefined) return

      loading = true
      void Taro.showLoading({ title: '正在上传查询图…', mask: true })
      const objectKey = await uploadVisualQueryImage(photo)
      void Taro.hideLoading()
      loading = false
      // 跳转失败（页面栈满）留在本页并给反馈，不静默吞掉
      void Taro.navigateTo({ url: visualSearchPageUrl(objectKey) }).catch(() => {
        void Taro.showToast({ title: '页面打开失败，请重试', icon: 'none' })
      })
    } catch (error) {
      // 先收掉 loading 再提示：`hideLoading` 与 `showToast` 共用同一层浮层，
      // 反序会把刚弹出的提示一起收掉（表现为"点了没反应"）
      if (loading) {
        void Taro.hideLoading()
        loading = false
      }
      void Taro.showToast({ title: visualSearchErrorMessage(error), icon: 'none' })
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

      <View className={`scanvis__cta${busy ? ' is-busy' : ''}`} onClick={startSearch}>
        <Text>{busy ? '正在上传…' : '拍照 / 从相册选'}</Text>
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
