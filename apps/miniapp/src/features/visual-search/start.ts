/**
 * 「上传查询图 → 跳识图结果页」这一段。三个入口共用：
 * 识图入口页（`pages/scan-vision`，自己开相机拍照并裁好）、搜索页顶栏的识图按钮、
 * 结果页的「换图」。抽出来的理由与 `features/upload/api.ts` 同源 —— 这条链有几个必须
 * 一致的细节，抄第二份迟早漂移：
 *
 * 1. `showLoading` / `hideLoading` 与 `showToast` 共用同一层浮层，**必须先收 loading 再提示**
 *    （反序会把刚弹出的提示一起收掉，表现为「点了没反应」）；
 * 2. 失败要给契约文案（`./messages`）；
 * 3. 上传在途由调用方防连点（原生面板是模态的，上传腿不是）。
 *
 * **跳转失败**（页面栈满）留在本页并给反馈，不静默吞掉。
 */

import Taro from '@tarojs/taro'
import type { PickedPhoto } from '@/features/upload/api'
import { pickPhotoFromSource } from '@/features/upload/api'
import { uploadVisualQueryImage, visualSearchErrorMessage } from './api'
import { bindVisualShot } from './handoff'
import { visionResultPageUrl } from './link'

/** 一次识图发起的结局：调用方据此决定要不要复位「在途」状态。 */
export type StartVisualSearchOutcome =
  /** 用户取消（来源弹窗或取图面板）—— 什么都没提示 */
  | 'cancelled'
  /** 本地校验挡下（HEIC / 超 5MB）—— 已提示原因 */
  | 'rejected'
  /** 已跳结果页 */
  | 'navigated'
  /** 上传失败，或上传成功但跳转失败 —— 都已提示 */
  | 'failed'

export type SubmitVisualQueryOptions = {
  /**
   * 调用方的在途判据（换号 / 卸载后中止上传腿）。不传表示不关心归属。
   */
  isActive?: () => boolean
  /**
   * 用 `redirectTo` 替换当前页（结果页的「换图」用它）：
   * 否则每换一次图都在页面栈里多压一层结果页，返回时要连按好几次。
   */
  replace?: boolean
  /** 上传成功、**即将跳转**时的钩子（调用方在这里作废自己的旧任务） */
  onUploaded?: (objectKey: string) => void
}

/**
 * 上传一张**已经拿到的**图，然后跳结果页。
 *
 * 识图入口页的相机快门与两个原生来源都走它：取图方式各不相同（相机拍 + 裁剪 / 相册 /
 * 聊天记录），但「上传 → 跳结果页」这一段必须只有一份实现。
 */
export async function submitVisualQuery(
  photo: PickedPhoto,
  options: SubmitVisualQueryOptions = {},
): Promise<StartVisualSearchOutcome> {
  let loading = false
  try {
    loading = true
    void Taro.showLoading({ title: '正在上传查询图…', mask: true })
    const objectKey = await uploadVisualQueryImage(photo, options.isActive)
    void Taro.hideLoading()
    loading = false

    // 「这是哪一次搜索」只有上传成功才知道：把入口页暂存的原图/取框绑定到这个键上，
    // 结果页据此取回自己的背景图（见 `./handoff`）
    bindVisualShot(objectKey)
    options.onUploaded?.(objectKey)

    // 本地临时路径一并带过去，给结果页的查询图当背景（查询图存私有前缀，
    // 服务端给不出可渲染 URL，见 `./link`）
    const url = visionResultPageUrl(objectKey, photo.path)
    const navigate = options.replace === true ? Taro.redirectTo : Taro.navigateTo
    try {
      await navigate({ url })
    } catch {
      // 跳转失败（页面栈满）：不上报成未发生，返回 `failed` 让调用方复位
      void Taro.showToast({ title: '页面打开失败，请重试', icon: 'none' })
      return 'failed'
    }
    return 'navigated'
  } catch (error) {
    // 先收掉 loading 再提示（两者共用同一层浮层，反序会把提示一起收掉）
    if (loading) void Taro.hideLoading()
    void Taro.showToast({ title: visualSearchErrorMessage(error), icon: 'none' })
    return 'failed'
  }
}

export type StartVisualSearchOptions = SubmitVisualQueryOptions & {
  /**
   * **取图成功、即将发起上传**时的钩子。
   *
   * 调用方要「作废在途的旧任务」时必须挂在这里，而不是在调用本函数之前：取图弹窗会一直
   * 停到用户选完或取消，提前作废会把「用户只是点了取消」也当成一次换图，让已经发出去的
   * 那次检索被丢弃（结果页会永远停在加载态、搜索页会丢一次本来能成的搜索）。
   */
  onPicked?: () => void
}

/**
 * 取图（弹来源）→ 上传 → 跳结果页。
 *
 * 搜索页的识图按钮与结果页的「换图」用它 —— 这两处没有相机，只能弹来源（相册 / 聊天记录）。
 * 识图入口页不走它（它自己开相机 + 两个直点按钮）。
 *
 * **取消是「什么都没发生」**：取图在用户选完之前不作废调用方的在途任务（见 `onPicked`），
 * 取消时也不提示、不导航 —— 调用方按返回值复位自己的「在途」标记即可。
 */
export async function startVisualSearch(
  options: StartVisualSearchOptions = {},
): Promise<StartVisualSearchOutcome> {
  let picked: Awaited<ReturnType<typeof pickPhotoFromSource>>
  try {
    picked = await pickPhotoFromSource()
  } catch (error) {
    void Taro.showToast({ title: visualSearchErrorMessage(error), icon: 'none' })
    return 'failed'
  }
  if (picked.photos.length === 0) {
    // 空结果只有两种：用户取消（静默）与本地校验挡下（说明原因）
    if (picked.rejected !== null) {
      void Taro.showToast({ title: picked.rejected, icon: 'none' })
      return 'rejected'
    }
    return 'cancelled'
  }
  const photo = picked.photos[0]
  if (photo === undefined) return 'cancelled'

  // 确定要换图了：此刻才作废调用方的旧任务（见 `onPicked` 的说明）
  options.onPicked?.()

  return submitVisualQuery(photo, options)
}
