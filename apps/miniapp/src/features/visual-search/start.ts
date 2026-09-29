/**
 * 「拍/选一张图 → 上传查询图 → 跳识图结果页」这条链的**唯一实现**。
 *
 * 两个入口共用它：识图入口页（`pages/scan-vision`）的主按钮，与搜索页顶栏的识图按钮；
 * 结果页的「重拍 / 换一张图」也走它。抽出来的理由与 `features/upload/api.ts` 同源 ——
 * 这条链有几个必须一致的细节，抄第二份迟早漂移：
 *
 * 1. 取图来源弹窗（拍摄 / 相册 / 聊天会话，见 `@/features/upload/api` 的 `pickPhotoFromSource`）；
 * 2. `showLoading` / `hideLoading` 与 `showToast` 共用同一层浮层，**必须先收 loading 再提示**
 *    （反序会把刚弹出的提示一起收掉，表现为「点了没反应」）；
 * 3. 取消要静默、本地校验被挡要说原因、其余失败给契约文案（`./messages`）；
 * 4. 上传在途由调用方防连点（`chooseMedia` 面板本身是模态的，上传腿不是）。
 *
 * **跳转失败**（页面栈满）留在本页并给反馈，不静默吞掉。
 */
import Taro from '@tarojs/taro'
import { pickPhotoFromSource } from '@/features/upload/api'
import { uploadVisualQueryImage, visualSearchErrorMessage } from './api'
import { visionResultPageUrl } from './link'

/** 一次识图发起的结局：调用方据此决定要不要复位「在途」状态。 */
export type StartVisualSearchOutcome =
  /** 用户取消（来源弹窗或取图面板）—— 什么都没提示 */
  | 'cancelled'
  /** 本地校验挡下（HEIC / 超 5MB）—— 已提示原因 */
  | 'rejected'
  /** 已跳结果页 */
  | 'navigated'
  /** 上传或跳转失败 —— 已提示 */
  | 'failed'

export type StartVisualSearchOptions = {
  /**
   * 调用方的在途判据（换号 / 卸载后中止上传腿）。不传表示不关心归属。
   */
  isActive?: () => boolean
  /**
   * 用 `redirectTo` 替换当前页（结果页的「重拍 / 换一张图」用它）：
   * 否则每换一次图都在页面栈里多压一层结果页，返回时要连按好几次。
   * 入口页（`scan-vision`）与搜索页传 `false`，它们是「往前一步」的语义。
   */
  replace?: boolean
}

/**
 * 取图 → 上传 → 跳结果页。
 */
export async function startVisualSearch(
  options: StartVisualSearchOptions = {},
): Promise<StartVisualSearchOutcome> {
  let loading = false
  try {
    const { photos, rejected } = await pickPhotoFromSource()
    if (photos.length === 0) {
      // 空结果只有两种：用户取消（静默）与本地校验挡下（说明原因）
      if (rejected !== null) {
        void Taro.showToast({ title: rejected, icon: 'none' })
        return 'rejected'
      }
      return 'cancelled'
    }
    const photo = photos[0]
    if (photo === undefined) return 'cancelled'

    loading = true
    void Taro.showLoading({ title: '正在上传查询图…', mask: true })
    const objectKey = await uploadVisualQueryImage(photo, options.isActive)
    void Taro.hideLoading()
    loading = false

    // 本地临时路径一并带过去，给结果页的查询图卡当缩略图（查询图存私有前缀，
    // 服务端给不出可渲染 URL，见 `./link`）
    const url = visionResultPageUrl(objectKey, photo.path)
    const navigate = options.replace === true ? Taro.redirectTo : Taro.navigateTo
    await navigate({ url }).catch(() => {
      void Taro.showToast({ title: '页面打开失败，请重试', icon: 'none' })
    })
    return 'navigated'
  } catch (error) {
    // 先收掉 loading 再提示（两者共用同一层浮层，反序会把提示一起收掉）
    if (loading) void Taro.hideLoading()
    void Taro.showToast({ title: visualSearchErrorMessage(error), icon: 'none' })
    return 'failed'
  }
}
