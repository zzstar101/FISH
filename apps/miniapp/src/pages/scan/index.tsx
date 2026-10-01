import { parseMeetupQrPayload } from '@fish/contracts/transactions/meetup-qr'
import { Camera, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useMemo, useState } from 'react'
import ScanTabs from '@/components/scan-tabs'
import { SCAN_CODE_PAGE } from '@/components/scan-tabs/tabs'
import { readNavMetrics } from '@/lib/nav-metrics'
import './index.scss'

/**
 * 扫一扫（通用二维码）—— Owner 2026-09-26 定版的「扫码家族」成员之一。
 *
 * 扫码家族按三段切换钮分工：**扫一扫（本页）负责非交易类二维码**，
 * 交易码（`pages/scan-pr`）负责面交核销，识图（商品识图搜索）后续另做。
 * 取景 UI、相机权限处理与 `pages/scan-pr` 同一套：页面内原生 `<Camera mode="scanCode">`
 * 打底、四块遮罩留出取景方框、顶部漂浮返回钮。
 *
 * 本页与交易码页的**结果分派**不同（#197 的登录码消费暂不在此页）：
 *
 * ```text
 * Camera onScanCode
 *   → parseMeetupQrPayload(rawValue) 非 null → 是交易码 → 提示去「交易码」页扫
 *   → 其它内容 → 本页暂时没有任何打开方式 → 「暂不支持」面板
 * ```
 *
 * 电脑端扫码登录（#197）的小程序码由微信扫码**直接拉起确认页**（scene 进页面参数），
 * 不经过本页中转；等 #197 的登录码契约冻结后，若需要在本页内识别再接分派，
 * 不提前假定其 payload 形状。
 *
 * **实现约定**
 * - `onScanCode` 对准期间连续触发：结果只切换到结果面板（`mode !== 'viewfinder'`
 *   即拦住后续触发），本页没有下游 navigateTo，不需要交易码页的 processing 锁。
 * - 「重新对准」回到取景后，同一枚码会再次触发分派并再次落面板 —— 与交易码页
 *   「重新扫」的语义一致，不算重试风暴。
 * - 相机权限被拒 / 其余相机错误都**不再弹阻断弹窗**（Owner 2026-09-29：弹窗老是挡住操作）——
 *   取景层就地换成一句说明 + 一个「去设置」，底部三段切换钮照常可用。
 */

/**
 * 结果反馈的原因条目与面板文案（渲染结构对齐 `pages/scan-pr` 的结果面板）。
 *
 * 原「硬件（设备没有可用摄像头）」一条随「无相机弹窗下线」一起删掉了（Owner 2026-09-29）：
 * 相机不可用现在只在取景层就地说明，不再走结果面板。
 */
const REASONS = [
  {
    key: 'is-txn',
    pipe: '交易码',
    pipeCls: 'is-warn',
    title: '这是鱼小应的交易码',
    desc: '面交核销要在「交易码」页完成，到那边扫同一个码即可。',
    action: 'code',
    actionLabel: '去交易码',
  },
  {
    key: 'unsupported',
    pipe: '暂未支持',
    pipeCls: 'is-mute',
    title: '没有对应的打开方式',
    desc: '后续开放更多能力后，这里可以直接打开它。',
    action: 'retry',
    actionLabel: '重新对准',
  },
] as const

/** 面板标题按原因区分：两条都是「扫到了但打不开」，不是扫码失败。 */
const SHEET_COPY: Record<ReasonKey, { title: string; sub: string }> = {
  'is-txn': { title: '扫到了交易码', sub: '换到「交易码」页就能继续' },
  unsupported: { title: '这个码暂不支持打开', sub: '识别成功了，但这里还没有对应的打开方式' },
}

type Mode = 'viewfinder' | 'errors'

type ReasonKey = (typeof REASONS)[number]['key']

type ReasonAction = (typeof REASONS)[number]['action']

/** onScanCode 事件 detail（weapp 的识别结果在 result 字段） */
type ScanCodeDetail = { result?: string }

/** 扫码结果的分派（纯逻辑，交易码形状 gate 复用 contracts 的唯一出口）。
 * 相机对识别不出的画面不触发 onScanCode，本页没有「解析失败」分支；
 * 空结果由 handleScanCode 的入口守卫拦下。 */
function classifyScan(rawValue: string): ReasonKey {
  if (parseMeetupQrPayload(rawValue) !== null) return 'is-txn'
  return 'unsupported'
}

export default function ScanQr() {
  const [mode, setMode] = useState<Mode>('viewfinder')
  /** 相机是否挂载：卸载 → 重挂是让报过错相机重启的唯一手段 */
  const [cameraOn, setCameraOn] = useState(true)
  /** 相机实例序号：作为 key，换号即整体重挂（报错恢复 / 回前台防预览冻结） */
  const [cameraEpoch, setCameraEpoch] = useState(0)
  /** 「扫码没成功」面板当前展示的原因（进入面板时一定带一个） */
  const [failureKey, setFailureKey] = useState<ReasonKey>('unsupported')

  // 返回钮与标题的垂直位置跟微信原生胶囊对齐（设备 px，内联下发，不参与 rpx 缩放）
  const nav = useMemo(() => readNavMetrics(), [])

  const goBack = () => {
    const pages = Taro.getCurrentPages()
    if (pages.length > 1) void Taro.navigateBack()
    else void Taro.switchTab({ url: '/pages/home/index' })
  }

  /**
   * 复核相机权限（页面显示 / 从设置页回来时走）。
   * `getSetting` 只返回**已请求过**的权限：`false` = 明确拒绝 → 取景层出说明（**不弹窗**）；
   * `true` 或未出现 = 已授权 / 从未询问 → 挂相机。
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
    syncCameraState()
  })

  /**
   * 相机层错误：**不再弹阻断弹窗**（Owner 2026-09-29）—— 权限被拒与硬件失败都只把取景层
   * 换成一句说明（`cameraOn=false`），底部三段切换钮照常可用。
   */
  const handleCameraError = () => {
    setCameraOn(false)
  }

  /** 扫码结果入口：分派只落结果面板，不在本页做任何下游导航。 */
  const handleScanCode = (event: { detail?: ScanCodeDetail }) => {
    if (mode !== 'viewfinder' || !event.detail?.result) return
    setFailureKey(classifyScan(event.detail.result))
    setMode('errors')
  }

  /** 从设置页回来：授权了就重挂相机；仍未授权就继续留在「相机不可用」的就地说明上。 */
  const openSetting = () => {
    void Taro.openSetting({})
      .then((res) => {
        if (res.authSetting['scope.camera']) {
          setCameraOn(true)
          setCameraEpoch((n) => n + 1)
        }
      })
      .catch(() => undefined)
  }

  /** 关掉结果面板回取景态（面板底部「关闭」钮 / 点击面板上方相机区域）。 */
  const closePanel = () => {
    setCameraOn(true)
    setMode('viewfinder')
  }

  const handleReasonAction = (action: ReasonAction) => {
    if (action === 'code') {
      void Taro.redirectTo({ url: SCAN_CODE_PAGE }).catch(() => {
        void Taro.showToast({ title: '页面打开失败，请重试', icon: 'none' })
      })
      return
    }
    closePanel()
  }

  return (
    <View className="scanqr">
      {/* ------- 取景底：原生相机（取景态）/ 无相机占位 ------- */}
      <View className="scanqr__view">
        {cameraOn ? (
          <Camera
            key={cameraEpoch}
            className="scanqr__camera"
            mode="scanCode"
            devicePosition="back"
            flash="off"
            resolution="high"
            onScanCode={handleScanCode}
            onError={handleCameraError}
            onStop={() => {
              // 非正常终止（如退后台）：换 key 重挂，回前台后由微信重新初始化
              setCameraEpoch((n) => n + 1)
            }}
          />
        ) : (
          <Text className="scanqr__view-label num">CAMERA PREVIEW PLACEHOLDER</Text>
        )}
      </View>

      {/* 遮罩四块：相机不可用时照常保留（不再整屏压暗 + 弹窗） */}
      <View className="scanqr__mask scanqr__mask--t" />
      <View className="scanqr__mask scanqr__mask--b" />
      <View className="scanqr__mask scanqr__mask--l" />
      <View className="scanqr__mask scanqr__mask--r" />

      {/* 取景框：恒可见 */}
      <View className={`scanqr__window${mode === 'viewfinder' ? '' : ' is-dim'}`}>
        {mode === 'viewfinder' ? <View className="scanqr__scanline" /> : null}
        <View className="scanqr__cnr scanqr__cnr--tl" />
        <View className="scanqr__cnr scanqr__cnr--tr" />
        <View className="scanqr__cnr scanqr__cnr--bl" />
        <View className="scanqr__cnr scanqr__cnr--br" />
      </View>

      {/*
        相机不可用：**不弹阻断弹窗**（Owner 2026-09-29）—— 就地说明 + 「去设置」，
        底部三段切换钮照常可用，用户随时能切到「识图」或「交易码」。
      */}
      {cameraOn ? null : (
        <View className="scanqr__noCam">
          <Text className="scanqr__noCam-title">相机不可用</Text>
          <Text className="scanqr__noCam-text">可以去「设置」允许使用相机，或切到其他入口</Text>
          <View className="scanqr__noCam-btn" onClick={openSetting}>
            <Text>去设置</Text>
          </View>
        </View>
      )}

      {/* ------- 顶部：返回 + 标题（垂直对齐右侧微信原生胶囊的中线） ------- */}
      <View
        className="scanqr__back"
        style={{ top: `${nav.statusBarHeight + nav.contentHeight / 2}px` }}
        onClick={goBack}
      >
        <View className="scanqr__back-chevron" />
      </View>
      <Text
        className="scanqr__topbar-title"
        style={{ top: `${nav.statusBarHeight + nav.contentHeight / 2}px` }}
      >
        扫一扫
      </Text>

      {/* ---------------- 提示文案（仅默认取景态） ---------------- */}
      {mode === 'viewfinder' ? (
        <View className="scanqr__hint">
          <Text className="scanqr__hint-title">对准要打开的二维码</Text>
          <Text className="scanqr__hint-text">非交易类二维码 · 对准后自动识别</Text>
        </View>
      ) : null}

      {/* ---------------- 底部：扫码家族切换钮（仅取景态） ---------------- */}
      {mode === 'viewfinder' ? <ScanTabs active="scan" /> : null}

      {/* ---- 「扫码没成功」结果反馈（只显示当前原因；可关闭，不挡演示） ---- */}
      {mode === 'errors' ? (
        <>
          {/* 面板之上的透明点击层：点面板以外任意位置直接回取景 */}
          <View className="scanqr__sheet-dismiss" onClick={closePanel} />
          <View className="scanqr__sheet scanqr__sheet--list">
            <View className="scanqr__grab" />
            <Text className="scanqr__sheet-title scanqr__sheet-title--left">
              {SHEET_COPY[failureKey].title}
            </Text>
            <Text className="scanqr__sheet-sub scanqr__sheet-sub--left">
              {SHEET_COPY[failureKey].sub}
            </Text>

            <View className="scanqr__reasons">
              {REASONS.filter((item) => item.key === failureKey).map((item) => (
                <View key={item.key} className="scanqr__frow">
                  <Text className={`scanqr__pipe ${item.pipeCls}`}>{item.pipe}</Text>
                  <View className="scanqr__fmain">
                    <Text className="scanqr__ft">{item.title}</Text>
                    <Text className="scanqr__fd">{item.desc}</Text>
                  </View>
                  <View className="scanqr__fact" onClick={() => handleReasonAction(item.action)}>
                    <Text>{item.actionLabel}</Text>
                  </View>
                </View>
              ))}
            </View>

            <View className="scanqr__btn-close" onClick={closePanel}>
              <Text>关闭</Text>
            </View>
          </View>
        </>
      ) : null}
    </View>
  )
}
