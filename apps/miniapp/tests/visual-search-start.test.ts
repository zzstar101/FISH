import { beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * 「取图 → 上传 → 跳结果页」这条链的**取消语义**。
 *
 * 为什么值得单独钉住：三个调用方（识图入口页 / 搜索页识图钮 / 结果页重拍）都用
 * `onPicked` 挂「作废在途的旧检索」。如果这个钩子在用户**还没选图之前**就被调用，
 * 「点开弹窗又取消」会把一次本来能成的检索作废掉 —— 结果页会永久停在骨架屏
 * （它的迟到守卫直接 `return`，`loading` 无人复位），搜索页会丢一次搜索且结果区空白。
 * 所以这里断言的核心就是：**取消时一次钩子都不许调**。
 *
 * 为什么用 `mock.module`：`./start` 会拉起 `@tarojs/taro`（`showLoading` / `navigateTo`），
 * Bun 下加载真 Taro 会抛 `ENABLE_INNER_HTML is not defined`（手法同
 * `tests/visual-search-upload.test.ts`）。
 */
const calls: string[] = []
let picked: {
  photos: { path: string; mime: string; sizeBytes: number }[]
  rejected: string | null
} = {
  photos: [],
  rejected: null,
}
let uploadError: unknown = null
let navigateError: unknown = null

mock.module('@tarojs/taro', () => ({
  default: {
    showLoading: () => calls.push('showLoading'),
    hideLoading: () => calls.push('hideLoading'),
    showToast: (options: { title: string }) => calls.push(`toast:${options.title}`),
    navigateTo: async () => {
      calls.push('navigateTo')
      if (navigateError) throw navigateError
    },
    redirectTo: async () => {
      calls.push('redirectTo')
      if (navigateError) throw navigateError
    },
  },
}))

mock.module('@/features/upload/api', () => ({
  pickPhotoFromSource: async () => picked,
}))

mock.module('@/features/visual-search/api', () => ({
  uploadVisualQueryImage: async () => {
    calls.push('upload')
    if (uploadError) throw uploadError
    return 'visual-search/abc/def.png'
  },
  visualSearchErrorMessage: (error: unknown) =>
    error instanceof Error ? `文案：${error.message}` : '识图失败，请稍后重试',
}))

const { startVisualSearch } = await import('@/features/visual-search/start')

const PHOTO = { path: '/tmp/q.png', mime: 'image/png', sizeBytes: 4 }

beforeEach(() => {
  calls.length = 0
  picked = { photos: [], rejected: null }
  uploadError = null
  navigateError = null
})

describe('startVisualSearch 的取消语义', () => {
  test('用户在来源弹窗取消：不调 onPicked、不上传、不提示', async () => {
    picked = { photos: [], rejected: null }
    let pickedHook = 0
    const outcome = await startVisualSearch({ onPicked: () => (pickedHook += 1) })
    expect(outcome).toBe('cancelled')
    expect(pickedHook).toBe(0)
    expect(calls).toEqual([])
  })

  test('本地校验挡下：只说原因，同样不调 onPicked', async () => {
    picked = { photos: [], rejected: '仅支持 JPG / PNG / WebP 图片' }
    let pickedHook = 0
    const outcome = await startVisualSearch({ onPicked: () => (pickedHook += 1) })
    expect(outcome).toBe('rejected')
    expect(pickedHook).toBe(0)
    expect(calls).toEqual(['toast:仅支持 JPG / PNG / WebP 图片'])
  })
})

describe('startVisualSearch 的正常链路', () => {
  test('取到图：onPicked 在**上传之前**调用，然后上传并跳转', async () => {
    picked = { photos: [PHOTO], rejected: null }
    let pickedHookAt = -1
    const outcome = await startVisualSearch({
      onPicked: () => {
        pickedHookAt = calls.length
        calls.push('onPicked')
      },
    })
    expect(outcome).toBe('navigated')
    expect(calls).toEqual(['onPicked', 'showLoading', 'upload', 'hideLoading', 'navigateTo'])
    // 钩子必须早于上传：晚于上传就变成「图都传完了才作废旧检索」，白花一次上游调用
    expect(pickedHookAt).toBe(0)
  })

  test('replace：用 redirectTo 替换当前页（结果页的「重拍」语义）', async () => {
    picked = { photos: [PHOTO], rejected: null }
    const outcome = await startVisualSearch({ replace: true })
    expect(outcome).toBe('navigated')
    expect(calls).toContain('redirectTo')
    expect(calls).not.toContain('navigateTo')
  })
})

describe('startVisualSearch 的失败语义', () => {
  test('上传失败：先收 loading 再提示，返回 failed', async () => {
    picked = { photos: [PHOTO], rejected: null }
    uploadError = new Error('boom')
    const outcome = await startVisualSearch()
    expect(outcome).toBe('failed')
    // 顺序：`hideLoading` 必须在 `showToast` 之前（共用同一层浮层，反序会把提示一起收掉）
    expect(calls).toEqual(['showLoading', 'upload', 'hideLoading', 'toast:文案：boom'])
  })

  test('跳转失败（页面栈满）：不谎报 navigated', async () => {
    picked = { photos: [PHOTO], rejected: null }
    navigateError = new Error('navigateTo:fail page limit')
    const outcome = await startVisualSearch()
    expect(outcome).toBe('failed')
    expect(calls).toContain('toast:页面打开失败，请重试')
  })
})
