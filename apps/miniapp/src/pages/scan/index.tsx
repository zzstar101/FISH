import { parseMeetupQrPayload } from '@fish/contracts/transactions/meetup-qr'
import { Camera, Image, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import './index.scss'

/**
 * C6 扫码（设计稿 `设计稿_C6-scan.html`）—— #114 真机扫码 × #70 交易码消费。
 *
 * 全屏深色取景页：页面内原生 `<Camera mode="scanCode">` 打底，
 * 上面压四块半透明遮罩留出中间的取景方框，方框四角是品牌色的 L 形描边，
 * 顶部漂浮返回钮与标题，下方提示文案。
 *
 * **本页只认二维码**（Owner 定版）：6 位码是「已知 transactionId 的订单/面交页」
 * 里的输入方式，不作为全局扫码页的无上下文入口 —— 面交页（transaction-meetup）
 * 自带 6 位输入，相机不可用时从本页返回即可。本页消费链路：
 *
 * ```text
 * Camera onScanCode
 *   → parseMeetupQrPayload(rawValue)          // 形状 gate：只放行鱼小应的交易码
 *   → navigateTo meetup?code=<rawValue>       // meetup 页解析出 { transactionId, token }
 *   → POST /transactions/:id/meetup-token/redeem → confirm / 刷新交易
 * ```
 *
 * **实现约定（#114）**
 * - 相机用**页面内**的原生 Camera 组件（`mode="scanCode"`），不调 `Taro.scanCode`
 *   跳微信系统扫码页，保留自定义取景 UI。进入页面相机即开，对准即扫。
 * - `invalid` 面板由形状 gate 触发：扫到的不是鱼小应的交易码（外部二维码 / 任意
 *   文本）就地拦下，不把垃圾转发给下游页。过期 / 已用 / 权限等业务校验归后端与
 *   meetup 页 —— 本页不解析 transactionId / token / expiry。
 * - `onScanCode` 在对准二维码期间会**连续触发**：用 `processingRef` 做本地锁，
 *   发起导航即上锁，页面重新显示（useDidShow）时解锁。导航失败同样解锁，但会把
 *   失败的码记入冷却期（5s 内同一枚不自动重试），否则连续触发的 onScanCode 会
 *   形成「失败 → 解锁 → 再扫同一枚」的重试风暴。
 * - 相机权限被拒（历史拒绝 / 授权弹窗拒绝）→ 「去设置 / 返回输入」弹窗，从设置页
 *   恢复后重挂相机；其余相机错误（被占用 / 无相机）→ 「扫码没成功」面板的硬件条目。
 *   拒绝的判据优先取 `getSetting` 的确定性结果，`onError` 的 errMsg 只做兜底。
 * - 从下游页返回时换 key 重挂相机（部分 iOS 机型页面 hide→show 后预览会冻结）。
 * - 相机实例用 `cameraEpoch` 作 key 管理：从下游页返回、收到 `onStop`（非正常
 *   终止，如退后台）都换号重挂，规避回前台后预览黑屏 / 冻结。
 */

/** 结果反馈的三种原因（稿子第 04 帧）。本页按当前失败原因只渲染对应条目；
 * 过期 / 已被使用等业务态由 meetup 页消费后端错误码时展示，不在本页。 */
const REASONS = [
  {
    key: 'no-camera',
    pipe: '硬件',
    pipeCls: 'is-warn',
    title: '设备没有可用摄像头',
    desc: '相机被占用或本机不支持。可以返回上一页手动输入对方的 6 位交易码。',
    action: 'back',
    actionLabel: '返回输入',
  },
  {
    key: 'parse',
    pipe: '解析',
    pipeCls: 'is-mute',
    title: '识别不出二维码',
    desc: '画面太糊、太远或反光。靠近一点、擦一下镜头再试。',
    action: 'retry',
    actionLabel: '重新对准',
  },
  {
    key: 'invalid',
    pipe: '无效',
    pipeCls: 'is-err',
    title: '这不是鱼小应的交易码',
    desc: '扫到的是其他二维码。请扫对方「交易码」页面上的那个。',
    action: 'retry',
    actionLabel: '重新扫',
  },
] as const

type Mode = 'viewfinder' | 'denied' | 'errors'

type ReasonKey = (typeof REASONS)[number]['key']

/** 扫码产物：业务无关的原始值。本页只做形状 gate，交给下游（#70 meetup 页消费）。 */
type ScanResult = { rawValue: string }

/** 相机错误事件 detail：微信只在 errMsg / errSubMsg 里给字符串 */
type CameraErrorDetail = { errMsg?: string; errSubMsg?: string }

/** onScanCode 事件 detail（weapp 的识别结果在 result 字段） */
type ScanCodeDetail = { result?: string }

/** 相机错误 errMsg 命中即视为「用户拒绝授权」，其余按硬件失败处理 */
const AUTH_DENY_PATTERN = /auth|deny|permission|权限/i

/** 导航失败后，同一枚二维码的自动重试冷却时间 */
const SCAN_RETRY_COOLDOWN_MS = 5000

export default function Scan() {
  const [mode, setMode] = useState<Mode>('viewfinder')
  /** 相机是否挂载：卸载 → 重挂是让报过错相机重启的唯一手段 */
  const [cameraOn, setCameraOn] = useState(true)
  /** 相机实例序号：作为 key，换号即整体重挂（报错恢复 / 返回本页防预览冻结） */
  const [cameraEpoch, setCameraEpoch] = useState(0)
  /** 「扫码没成功」面板当前展示的原因（进入面板时一定带一个） */
  const [failureKey, setFailureKey] = useState<ReasonKey>('no-camera')

  /** 防重复消费锁：onScanCode 从发起导航到页面隐藏期间为 true */
  const processingRef = useRef(false)
  /** 上一次导航失败的二维码：冷却期内同一枚码不自动重试 */
  const failedScanRef = useRef<{ value: string; at: number } | null>(null)

  const statusBarHeight = (() => {
    try {
      return Taro.getWindowInfo().statusBarHeight ?? 20
    } catch {
      return 20
    }
  })()

  const goBack = () => {
    const pages = Taro.getCurrentPages()
    if (pages.length > 1) void Taro.navigateBack()
    else void Taro.switchTab({ url: '/pages/home/index' })
  }

  /**
   * 复核相机权限（页面显示 / 从设置页回来时走）。
   *
   * `getSetting` 只返回**已请求过**的权限：`false` = 明确拒绝 → 无权限弹窗；
   * `true` 或未出现 = 已授权 / 从未询问 → 挂相机（从未询问时微信自己拉授权弹窗）。
   */
  const syncCameraState = () => {
    void Taro.getSetting()
      .then((res) => {
        if (res.authSetting['scope.camera'] === false) {
          setCameraOn(false)
          setMode('denied')
          return
        }
        setCameraOn(true)
        setMode((prev) => (prev === 'denied' ? 'viewfinder' : prev))
      })
      .catch(() => {
        // getSetting 失败：仍尝试挂相机，授权结果交给 onError 兜底
        setCameraOn(true)
        setMode((prev) => (prev === 'denied' ? 'viewfinder' : prev))
      })
  }

  useDidShow(() => {
    // 页面重新显示 = 上一次扫码消费已结束：解锁；同时复核权限（设置页可能已改动）。
    // 从下游页回来时换 key 重挂相机，规避部分 iOS 机型 hide→show 后预览冻结。
    const wasProcessing = processingRef.current
    processingRef.current = false
    if (wasProcessing) setCameraEpoch((n) => n + 1)
    syncCameraState()
  })

  /**
   * 相机层错误：优先用 `getSetting` 的确定性结果分类——`scope.camera === false`
   * 即「用户拒绝授权」，权限仍在则按硬件失败（被占用 / 无相机）处理；
   * getSetting 拿不到时才退回 errMsg 关键字兜底。
   */
  const handleCameraError = (event: { detail?: CameraErrorDetail }) => {
    const message = `${event.detail?.errMsg ?? ''} ${event.detail?.errSubMsg ?? ''}`
    const toDenied = () => {
      setCameraOn(false)
      setMode('denied')
    }
    const toHardware = () => {
      setCameraOn(false)
      setFailureKey('no-camera')
      setMode('errors')
    }
    void Taro.getSetting()
      .then((res) => (res.authSetting['scope.camera'] === false ? toDenied() : toHardware()))
      .catch(() => (AUTH_DENY_PATTERN.test(message) ? toDenied() : toHardware()))
  }

  /**
   * 扫码结果入口：`parseMeetupQrPayload` 做形状 gate —— 只有鱼小应的交易码
   * （`fish://meetup/redeem?tx=…&t=…`）放行去 meetup 页消费，其余就地落「无效」
   * 面板。onScanCode 对准期间会连续触发，上锁后同一枚二维码只发起一次导航。
   */
  const handleScanCode = (event: { detail?: ScanCodeDetail }) => {
    const result: ScanResult = { rawValue: event.detail?.result ?? '' }
    if (processingRef.current || mode !== 'viewfinder' || !result.rawValue) return
    const failed = failedScanRef.current
    if (
      failed &&
      failed.value === result.rawValue &&
      Date.now() - failed.at < SCAN_RETRY_COOLDOWN_MS
    ) {
      return
    }
    if (parseMeetupQrPayload(result.rawValue) === null) {
      processingRef.current = true
      failedScanRef.current = { value: result.rawValue, at: Date.now() }
      setFailureKey('invalid')
      setMode('errors')
      return
    }
    processingRef.current = true
    void Taro.navigateTo({
      url: `/pages/transaction-meetup/index?code=${encodeURIComponent(result.rawValue)}`,
    }).catch(() => {
      // 导航失败（如页面栈满）：解锁留在取景态，同一枚码冷却期内不自动重试
      processingRef.current = false
      failedScanRef.current = { value: result.rawValue, at: Date.now() }
      void Taro.showToast({ title: '页面打开失败，请重试', icon: 'none' })
    })
  }

  const openSetting = () => {
    void Taro.openSetting({})
      .then((res) => {
        if (res.authSetting['scope.camera']) {
          setCameraOn(true)
          setMode('viewfinder')
        }
        // 仍未授权：停在无权限弹窗，等下次进设置
      })
      .catch(() => undefined)
  }

  return (
    <View className="scan">
      {/* ------- 取景底：原生相机（取景态）/ 无相机占位 ------- */}
      <View className="scan__view">
        {cameraOn ? (
          <Camera
            key={cameraEpoch}
            className="scan__camera"
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
          <Text className="scan__view-label num">CAMERA PREVIEW PLACEHOLDER</Text>
        )}
      </View>

      {/* 遮罩四块；「无权限」时整屏压暗（稿子第 03 帧的 mask-full） */}
      {mode === 'denied' ? (
        <View className="scan__mask scan__mask--full" />
      ) : (
        <>
          <View className="scan__mask scan__mask--t" />
          <View className="scan__mask scan__mask--b" />
          <View className="scan__mask scan__mask--l" />
          <View className="scan__mask scan__mask--r" />
        </>
      )}

      {/* 取景框：仅取景 / 错误列表时可见 */}
      {mode === 'denied' ? null : (
        <View className={`scan__window${mode === 'viewfinder' ? '' : ' is-dim'}`}>
          {mode === 'viewfinder' ? <View className="scan__scanline" /> : null}
          <View className="scan__cnr scan__cnr--tl" />
          <View className="scan__cnr scan__cnr--tr" />
          <View className="scan__cnr scan__cnr--bl" />
          <View className="scan__cnr scan__cnr--br" />
        </View>
      )}

      {/* ---------------- 顶部：返回 + 标题 ---------------- */}
      <View className="scan__status" style={{ height: `${statusBarHeight}px` }} />
      <View className="scan__topbar">
        <View className="scan__back" onClick={goBack}>
          <View className="scan__back-chevron" />
        </View>
        <Text className="scan__topbar-title">扫码</Text>
      </View>

      {/* ---------------- 提示文案（仅默认取景态） ---------------- */}
      {mode === 'viewfinder' ? (
        <View className="scan__hint">
          <Text className="scan__hint-title">对准对方的交易码</Text>
          <Text className="scan__hint-text">约 20cm 距离 · 对准后自动识别</Text>
        </View>
      ) : null}

      {/* ---------------- 提示：6 位码在面交页输入（取景态底部） ---------------- */}
      {mode === 'viewfinder' ? (
        <View className="scan__manualbar">
          <View className="scan__btn-manual" onClick={goBack}>
            <Image className="scan__btn-manual-ic" src={ICONS.key} mode="aspectFit" />
            <Text>用 6 位数字核销</Text>
          </View>
          <Text className="scan__manual-note num">在对应订单的交易码页面手动输入</Text>
        </View>
      ) : null}

      {/* ---------------- 无相机权限（稿子第 03 帧） ---------------- */}
      {mode === 'denied' ? (
        <>
          <View className="scan__scrim scan__scrim--full" />
          <View className="scan__cdialog">
            <View className="scan__cdisc">
              <Image className="scan__cdisc-ic" src={ICONS.cameraOff} mode="aspectFit" />
            </View>
            <Text className="scan__cdialog-title">没有相机权限</Text>
            <Text className="scan__cdialog-text">
              去「设置」允许使用相机后即可扫码。不想开权限也可以返回上一页，在订单的交易码页面手动输入
              6 位数字。
            </Text>
            <View className="scan__cacts">
              <View className="scan__btn-main scan__btn-main--flat" onClick={openSetting}>
                <Text>去设置</Text>
              </View>
              <View className="scan__btn-ghost" onClick={goBack}>
                <Image className="scan__btn-ghost-ic" src={ICONS.key} mode="aspectFit" />
                <Text>返回手动输入</Text>
              </View>
            </View>
          </View>
        </>
      ) : null}

      {/* ---------------- 「扫码没成功」结果反馈（稿子第 04 帧，只显示当前原因） ---------------- */}
      {mode === 'errors' ? (
        <View className="scan__sheet scan__sheet--list">
          <View className="scan__grab" />
          <Text className="scan__sheet-title scan__sheet-title--left">扫码没成功</Text>
          <Text className="scan__sheet-sub scan__sheet-sub--left">
            按原因给不同出口，不让用户卡在同一个按钮上
          </Text>

          <View className="scan__reasons">
            {REASONS.filter((item) => item.key === failureKey).map((item) => (
              <View key={item.key} className="scan__frow">
                <Text className={`scan__pipe ${item.pipeCls}`}>{item.pipe}</Text>
                <View className="scan__fmain">
                  <Text className="scan__ft">{item.title}</Text>
                  <Text className="scan__fd">{item.desc}</Text>
                </View>
                <View
                  className="scan__fact"
                  onClick={() => {
                    if (item.action === 'back') {
                      goBack()
                    } else {
                      // retry 回取景：相机若已卸下会重挂（错误过的实例不会自愈）
                      setCameraOn(true)
                      setMode('viewfinder')
                    }
                  }}
                >
                  <Text>{item.actionLabel}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  )
}
