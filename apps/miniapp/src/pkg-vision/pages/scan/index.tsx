import { Camera, Image, Text, View } from '@tarojs/components'
import Taro, { useDidShow, useRouter } from '@tarojs/taro'
import { useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import ScanTabs from '@/components/scan-tabs'
import { parseScanEntry, type ScanTabKey } from '@/components/scan-tabs/tabs'
import type { PickedPhoto } from '@/features/upload/api'
import { pickPhotoOfSource, readFileSize } from '@/features/upload/api'
import { isChooseMediaCancel } from '@/features/upload/choose-error'
import { visualSearchErrorMessage } from '@/features/visual-search/api'
import { stashVisualShot } from '@/features/visual-search/handoff'
import { submitVisualQuery } from '@/features/visual-search/start'
import { backButtonGeometry, readNavMetrics } from '@/lib/nav-metrics'
import { type ScanFailure, scanOutcome } from './outcome'
import { decodeCanvasSize, decodeQrPixels } from './qr-decode'
import './index.scss'

/**
 * 扫码页（#583）：**一个页面**、底部两段 tab「扫一扫 / 拍图搜」页内切换。
 *
 * ```text
 * ?tab=scan（缺省）  <Camera mode="scanCode">  对准交易码自动识别 / 相册里选一张交易码截图
 *                    → scanOutcome(rawValue)：只认鱼小应的交易码 → 面交页核销
 * ?tab=photo         <Camera mode="normal">    快门 / 相册 / 聊天记录 → 整图上传 → 识图结果页
 * ```
 *
 * 切 tab 换 Camera 的 key 整体重挂：`mode` 在同一个相机实例上切换不保证生效。
 *
 * **实现约定（沿用 #114 / #536）**
 * - `onScanCode` 对准期间会**连续触发**：`processingRef` 做本地锁，发起导航 / 弹失败面板即上锁，
 *   页面重新显示或「重新扫」时解锁。导航失败同样解锁，但把这枚码记入 5s 冷却
 *   （否则「失败 → 解锁 → 再扫同一枚」形成重试风暴）。
 * - `cameraEpoch` 作 key：页面 hide→show（下游页 / 相册 / 设置页回来）与 `onStop` 都换号重挂，
 *   规避部分 iOS 机型回前台后预览黑屏 / 冻结。
 * - 相机不可用（权限被拒 / 无相机 / 被占用）**不弹阻断弹窗**：取景层换成纯黑 + 居中说明 +
 *   「去设置」，底部 tab 与相册等入口照常可用。拒绝的判据优先取 `getSetting` 的确定性结果，
 *   `onError` 只做兜底。
 * - 「输入 6 位交易码」只在**从面交页进来**时出现（入口带 `from=meetup`，见 `scanPageUrl`）：
 *   6 位码只能在具体订单的面交页输入（那里才知道 transactionId），点它直接返回那页。
 */

/** 「扫码没成功」面板的两种原因（Owner 拍板：只留这两条） */
const FAILURES: Record<ScanFailure, { title: string; desc: string }> = {
  invalid: {
    title: '这不是鱼小应的交易码',
    desc: '扫到的是其他二维码。请扫对方「交易码」页面上的那个。',
  },
  'no-qr': {
    title: '图里没找到二维码',
    desc: '换一张清晰、完整包含交易码的截图再试。',
  },
}

/** onScanCode 事件 detail（weapp 的识别结果在 result 字段） */
type ScanCodeDetail = { result?: string }

/** 导航失败 / 判无效后，同一枚二维码的自动重试冷却时间 */
const SCAN_RETRY_COOLDOWN_MS = 5000

export default function Scan() {
  const router = useRouter<Record<string, string | undefined>>()
  /** 进页参数：初始 tab 与「是否从面交页进来」。进页时定下，之后不变 */
  const entry = useMemo(
    () => parseScanEntry({ tab: router.params.tab, from: router.params.from }),
    [router.params],
  )

  const [tab, setTab] = useState<ScanTabKey>(entry.tab)
  /** 相机是否可用（不可用时只出说明，不阻断操作） */
  const [cameraOn, setCameraOn] = useState(true)
  /** 相机实例序号：与 tab 一起作 key，换号即整体重挂 */
  const [cameraEpoch, setCameraEpoch] = useState(0)
  /** 「扫码没成功」面板当前的原因；`null` = 取景态 */
  const [failure, setFailure] = useState<ScanFailure | null>(null)
  /** 相册识码 / 拍图上传在途：底部按钮防连点（原生面板是模态的，后续腿不是） */
  const [busy, setBusy] = useState(false)

  /** 防重复消费锁：onScanCode 从发起导航 / 弹面板到解锁期间为 true */
  const processingRef = useRef(false)
  /** 在途的同步判据（`busy` 是状态，同一帧连点读不到新值） */
  const busyRef = useRef(false)
  /** 上一次没走通的二维码：冷却期内同一枚码不自动重试 */
  const failedScanRef = useRef<{ value: string; at: number } | null>(null)
  /** 首次 didShow 不重挂相机（刚挂上） */
  const shownRef = useRef(false)

  // 返回钮的垂直位置跟微信原生胶囊对齐（设备 px，内联下发，不参与 rpx 缩放）
  const nav = useMemo(() => readNavMetrics(), [])
  const backGeo = backButtonGeometry(nav.capsuleHeight)

  const goBack = () => {
    const pages = Taro.getCurrentPages()
    if (pages.length > 1) void Taro.navigateBack()
    else void Taro.switchTab({ url: '/pages/home/index' })
  }

  /**
   * 复核相机权限（页面显示 / 从设置页回来时走）。
   *
   * `getSetting` 只返回**已请求过**的权限：`false` = 明确拒绝 → 取景层出说明（**不弹窗**）；
   * `true` 或未出现 = 已授权 / 从未询问 → 挂相机（从未询问时微信自己拉授权弹窗）。
   */
  const syncCameraState = () => {
    void Taro.getSetting()
      .then((res) => {
        setCameraOn(res.authSetting['scope.camera'] !== false)
      })
      .catch(() => {
        // getSetting 失败：仍尝试挂相机，授权结果交给 onError 兜底
        setCameraOn(true)
      })
  }

  useDidShow(() => {
    // 页面重新显示 = 上一次扫码消费已结束：解锁；换 key 重挂相机（防预览冻结）；
    // 同时复核权限（设置页可能已改动）。失败面板开着时锁照样由面板守卫挡住扫码。
    processingRef.current = false
    if (shownRef.current) setCameraEpoch((n) => n + 1)
    shownRef.current = true
    syncCameraState()
  })

  const openSetting = () => {
    void Taro.openSetting({})
      .then((res) => {
        if (res.authSetting['scope.camera']) setCameraOn(true)
        // 仍未授权：停在说明，等下次进设置
      })
      .catch(() => undefined)
  }

  const switchTab = (next: ScanTabKey) => {
    if (busyRef.current) return
    processingRef.current = false
    setFailure(null)
    setTab(next)
  }

  /* ------------------------------------------------------------ 扫一扫 */

  /**
   * 扫码结果分派（相机识码与相册识码同一个出口）：交易码 → 面交页；其余 → 失败面板。
   * `rawValue === null` 只来自相册（图里没解出二维码）。
   */
  const dispatchScan = (rawValue: string | null) => {
    const outcome = scanOutcome(rawValue)
    processingRef.current = true
    if (outcome.kind === 'failure') {
      if (rawValue !== null) failedScanRef.current = { value: rawValue, at: Date.now() }
      setFailure(outcome.reason)
      return
    }
    void Taro.navigateTo({ url: outcome.url }).catch(() => {
      // 导航失败（如页面栈满）：解锁留在取景态，同一枚码冷却期内不自动重试
      processingRef.current = false
      if (rawValue !== null) failedScanRef.current = { value: rawValue, at: Date.now() }
      void Taro.showToast({ title: '页面打开失败，请重试', icon: 'none' })
    })
  }

  const handleScanCode = (event: { detail?: ScanCodeDetail }) => {
    const rawValue = event.detail?.result ?? ''
    if (processingRef.current || busyRef.current || failure !== null || !rawValue) return
    const failed = failedScanRef.current
    if (failed && failed.value === rawValue && Date.now() - failed.at < SCAN_RETRY_COOLDOWN_MS) {
      return
    }
    dispatchScan(rawValue)
  }

  /** 相册识码：选一张图 → 端上解码（离屏 Canvas + jsQR）→ 同一个分派。 */
  const scanAlbum = async () => {
    if (busyRef.current || failure !== null) return
    busyRef.current = true
    setBusy(true)
    try {
      let path: string | undefined
      try {
        const res = await Taro.chooseMedia({
          count: 1,
          mediaType: ['image'],
          sourceType: ['album'],
          sizeType: ['compressed'],
        })
        path = res.tempFiles[0]?.tempFilePath
      } catch (error) {
        // 只吞「用户取消」；权限被拒 / 平台失败给一句提示
        if (!isChooseMediaCancel(error)) {
          void Taro.showToast({ title: '无法选择图片，请检查相册权限后重试', icon: 'none' })
        }
        return
      }
      if (path === undefined) return
      // 读图 / 画布任何一步失败都当「没解出来」：对用户而言就是这张图里找不到码
      const rawValue = await readQrFromImage(path).catch(() => null)
      dispatchScan(rawValue)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  /** 「输入 6 位交易码」：只在从面交页进来时出现，直接返回那页输入。 */
  const goManualInput = () => {
    void Taro.navigateBack()
  }

  /** 面板「重新扫」/ 点面板外：回取景，解锁 */
  const dismissFailure = () => {
    processingRef.current = false
    setFailure(null)
  }

  /* ------------------------------------------------------------ 拍图搜 */

  const shoot = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      let path: string
      try {
        path = await new Promise<string>((resolve, reject) => {
          Taro.createCameraContext().takePhoto({
            // normal：整图直接上传，查询图有 5MB 上限，high 档在部分机型上会超
            quality: 'normal',
            success: (res) => resolve(res.tempImagePath),
            fail: (res) => reject(new Error(res.errMsg)),
          })
        })
      } catch {
        void Taro.showToast({ title: '拍摄失败，请重试', icon: 'none' })
        return
      }
      // 拍照原图交给结果页当背景（必须在跳转之前 stash，见 `features/visual-search/handoff`）
      stashVisualShot({ path })
      // 字节数由文件系统读（`takePhoto` 不给 size）；上传前服务端还会按真实字节复核
      const photo: PickedPhoto = { path, mime: 'image/jpeg', sizeBytes: readFileSize(path) }
      await submitVisualQuery(photo)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  /** 从相册 / 聊天记录取图：取到的就是成品图，直接整图上传。 */
  const pickFrom = async (source: 'album' | 'chat') => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const { photos, rejected } = await pickPhotoOfSource(source)
      const photo = photos[0]
      if (photo === undefined) {
        if (rejected !== null) void Taro.showToast({ title: rejected, icon: 'none' })
        return
      }
      await submitVisualQuery(photo)
    } catch (error) {
      void Taro.showToast({ title: visualSearchErrorMessage(error), icon: 'none' })
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  /* ------------------------------------------------------------ 渲染 */

  const noCamText =
    tab === 'scan'
      ? '可以去「设置」允许使用相机，或从相册选一张交易码截图'
      : '可以去「设置」允许使用相机，或改用相册、聊天记录'

  return (
    <View className="scanpage">
      {/* ---------------- 全屏相机 / 相机不可用（纯黑 + 居中说明） ---------------- */}
      {cameraOn ? (
        <Camera
          key={`${tab}-${cameraEpoch}`}
          className="scanpage__camera"
          mode={tab === 'scan' ? 'scanCode' : 'normal'}
          devicePosition="back"
          flash="off"
          onScanCode={tab === 'scan' ? handleScanCode : undefined}
          onError={() => setCameraOn(false)}
          onStop={() => {
            // 非正常终止（如退后台）：换 key 重挂，回前台后由微信重新初始化
            setCameraEpoch((n) => n + 1)
          }}
        />
      ) : (
        <View className="scanpage__noCam">
          <Text className="scanpage__noCam-title">相机不可用</Text>
          <Text className="scanpage__noCam-text">{noCamText}</Text>
          <View className="scanpage__noCam-btn" onClick={openSetting}>
            <Text>去设置</Text>
          </View>
        </View>
      )}

      {/* ---------------- 顶部：只有返回钮（垂直对齐右侧微信原生胶囊的中线） ---------------- */}
      <View
        className="scanpage__back"
        style={{
          top: `${nav.statusBarHeight + nav.contentHeight / 2}px`,
          ...backGeo.btnStyle,
        }}
        onClick={goBack}
      >
        <View className="scanpage__back-chevron" style={backGeo.chevronStyle} />
      </View>

      {/* ---------------- 底部自下而上：tab 行 → 操作行 → 一行提示 ---------------- */}
      {cameraOn ? (
        <Text className="scanpage__hint">
          {tab === 'scan' ? '对准对方的交易码，自动识别' : '对准想搜的商品，按下快门'}
        </Text>
      ) : null}

      {tab === 'scan' ? (
        <View className="scanpage__actions">
          <View
            className={`scanpage__act${busy ? ' is-busy' : ''}`}
            onClick={() => void scanAlbum()}
          >
            <Image className="scanpage__act-ic" src={ICONS.imageWhite} mode="aspectFit" />
            <Text className="scanpage__act-label">相册</Text>
          </View>
          <View className="scanpage__act-slot" />
          {entry.fromMeetup ? (
            <View className="scanpage__act" onClick={goManualInput}>
              <Image className="scanpage__act-ic" src={ICONS.keyWhite} mode="aspectFit" />
              <Text className="scanpage__act-label">输入 6 位码</Text>
            </View>
          ) : (
            <View className="scanpage__act-slot" />
          )}
        </View>
      ) : (
        <View className="scanpage__actions">
          <View
            className={`scanpage__act${busy ? ' is-busy' : ''}`}
            onClick={() => void pickFrom('album')}
          >
            <Image className="scanpage__act-ic" src={ICONS.imageWhite} mode="aspectFit" />
            <Text className="scanpage__act-label">相册</Text>
          </View>
          <View
            className={`scanpage__shutter${busy || !cameraOn ? ' is-busy' : ''}`}
            onClick={() => {
              if (cameraOn) void shoot()
            }}
          >
            <View className="scanpage__shutter-core" />
          </View>
          <View
            className={`scanpage__act${busy ? ' is-busy' : ''}`}
            onClick={() => void pickFrom('chat')}
          >
            <Image className="scanpage__act-ic" src={ICONS.chatWhite} mode="aspectFit" />
            <Text className="scanpage__act-label">聊天记录</Text>
          </View>
        </View>
      )}

      <ScanTabs active={tab} onChange={switchTab} />

      {/* ---------------- 「扫码没成功」白色底部面板：点面板外或「重新扫」回取景 ---------------- */}
      {failure !== null ? (
        <>
          <View className="scanpage__sheet-dismiss" onClick={dismissFailure} />
          <View className="scanpage__sheet">
            <View className="scanpage__grab" />
            <Text className="scanpage__sheet-title">{FAILURES[failure].title}</Text>
            <Text className="scanpage__sheet-sub">{FAILURES[failure].desc}</Text>
            <View className="scanpage__sheet-btn" onClick={dismissFailure}>
              <Text>重新扫</Text>
            </View>
          </View>
        </>
      ) : null}
    </View>
  )
}

/**
 * 离屏 2D Canvas 的最小形状。`Taro.OffscreenCanvas.getContext` 的返回类型是空接口
 * `RenderingContext`（Taro 类型只声明了 WebGL 用法），这里只声明用到的两个方法。
 */
type OffscreenContext2D = {
  drawImage: (image: Taro.Image, dx: number, dy: number, dw: number, dh: number) => void
  getImageData: (sx: number, sy: number, sw: number, sh: number) => Taro.ImageData
}

/**
 * 读一张本地图里的二维码：`getImageInfo` 拿原尺寸 → 长边收到 `MAX_DECODE_SIDE` →
 * 离屏 Canvas（基础库 2.16.1+）画上去取像素 → jsQR。没解出来返回 `null`。
 */
async function readQrFromImage(path: string): Promise<string | null> {
  const info = await Taro.getImageInfo({ src: path })
  const size = decodeCanvasSize({ width: info.width, height: info.height })
  const canvas = Taro.createOffscreenCanvas({ type: '2d', width: size.width, height: size.height })
  const ctx = canvas.getContext('2d') as OffscreenContext2D
  const image = canvas.createImage()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('图片读取失败'))
    image.src = path
  })
  ctx.drawImage(image, 0, 0, size.width, size.height)
  const pixels = ctx.getImageData(0, 0, size.width, size.height)
  return decodeQrPixels(pixels.data, pixels.width, pixels.height)
}
