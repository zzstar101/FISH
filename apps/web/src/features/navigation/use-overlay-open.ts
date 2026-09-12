import { useSyncExternalStore } from 'react'

/**
 * 页面上是否有底部弹层打开。
 *
 * 底部导航是 `fixed` 的，弹层只盖住自己那块区域时，导航会露在遮罩外面，
 * 观感是「面板浮在导航上面、导航还在最底下亮着」。这里用一个 DOM 观察器统一判断，
 * 弹层一开就让导航下沉淡出（导航自己也会把层级压到弹层下面，见 tab-bar.tsx）。
 *
 * 识别方式兼容两类弹层：
 * - 手写弹层（许愿 / 选择器）在根节点上标 `data-overlay-open`；
 * - Radix 系弹层自带 `role="dialog"` / `role="alertdialog"` + `data-state="open"`，
 *   vaul 的 Drawer 同理。
 * 下拉菜单、Popover、Sonner toast 不算全屏弹层，不在此列——它们不遮挡导航。
 */
const OVERLAY_SELECTOR = [
  '[data-overlay-open]',
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[data-vaul-drawer][data-state="open"]',
].join(',')

const listeners = new Set<() => void>()
let observer: MutationObserver | null = null
let snapshot = false

function read() {
  return document.querySelector(OVERLAY_SELECTOR) !== null
}

function refresh() {
  const next = read()
  if (next === snapshot) return
  snapshot = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!observer) {
    observer = new MutationObserver(refresh)
    observer.observe(document.body, {
      // 只盯弹层的开关属性；不带 class，避免导航自身的动画触发回调。
      attributeFilter: ['data-overlay-open', 'data-state', 'role'],
      attributes: true,
      childList: true,
      subtree: true,
    })
    // 订阅时可能已经有弹层开着，先对一次现况；useSyncExternalStore 会在订阅后
    // 重新读快照，值变了会自己补一次渲染。
    snapshot = read()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      observer?.disconnect()
      observer = null
    }
  }
}

const getServerSnapshot = () => false

export function useOverlayOpen() {
  return useSyncExternalStore(subscribe, () => snapshot, getServerSnapshot)
}
