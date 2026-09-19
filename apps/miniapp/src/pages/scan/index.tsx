import { Camera, Image, Input, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import './index.scss'

/**
 * C6 扫码（设计稿 `设计稿_C6-scan.html`）。
 *
 * 全屏深色取景页：页面内原生 `<Camera mode="scanCode">` 打底（#114 真机扫码），
 * 上面压四块半透明遮罩留出中间的取景方框，方框四角是品牌色的 L 形描边，
 * 顶部漂浮返回钮与标题，下方提示文案，底部「手动输入交易码」入口。
 *
 * **手动输入是必备 fallback**（稿子第 02 帧）：无相机 / 权限被拒 / 二维码损坏 /
 * 用户主动选择时都进这里。6 格输入 + 错误态 + 凑够 6 位才能提交。
 *
 * **实现约定（#114）**
 * - 相机用**页面内**的原生 Camera 组件（`mode="scanCode"`），不调 `Taro.scanCode`
 *   跳微信系统扫码页，保留自定义取景 UI。进入页面相机即开，对准即扫。
 * - 扫码结果**只输出业务无关的原始字符串**（`ScanResult.rawValue`）。本页不解析
 *   transactionId / token / challengeId / expiry，全部交给 #70 Transaction Domain。
 * - `onScanCode` 在对准二维码期间会**连续触发**：用 `processingRef` 做本地锁，
 *   发起导航即上锁，页面重新显示（useDidShow）时解锁。导航失败同样解锁，但会把
 *   失败的码记入冷却期（5s 内同一枚不自动重试），否则连续触发的 onScanCode 会
 *   形成「失败 → 解锁 → 再扫同一枚」的重试风暴。
 * - 相机权限被拒（历史拒绝 / 授权弹窗拒绝）→ 「去设置 / 手动输入」弹窗，从设置页
 *   恢复后重挂相机；其余相机错误（被占用 / 无相机）→ 「扫码没成功」面板的硬件条目。
 *   拒绝的判据优先取 `getSetting` 的确定性结果，`onError` 的 errMsg 只做兜底。
 * - 从下游页返回时换 key 重挂相机（部分 iOS 机型页面 hide→show 后预览会冻结）。
 * - 交易码是否合法 / 过期 / 可消费归 #70；本页不做码校验。
 * - 相机实例用 `cameraEpoch` 作 key 管理：从下游页返回、收到 `onStop`（非正常
 *   终止，如退后台）都换号重挂，规避回前台后预览黑屏 / 冻结；手动输入期间
 *   有意卸载相机，释放占用。
 */

/** 结果反馈的四种原因（稿子第 04 帧）。本页按当前失败原因只渲染对应条目；
 * `parse` / `invalid` / `expired` 的真实触发在 #70 接入消费接口之后。 */
const REASONS = [
  {
    key: 'no-camera',
    pipe: '硬件',
    pipeCls: 'is-warn',
    title: '设备没有可用摄像头',
    desc: '相机被占用或本机不支持。可以直接手动输入交易码。',
    action: 'manual',
    actionLabel: '手动输入',
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
  {
    key: 'expired',
    pipe: '过期',
    pipeCls: 'is-err',
    title: '交易码已过期',
    desc: '交易码一次性且短时有效。请对方在页面上点「刷新」后再扫。',
    action: 'dismiss',
    actionLabel: '我知道了',
  },
] as const

type Mode = 'viewfinder' | 'manual' | 'denied' | 'errors'

type ReasonKey = (typeof REASONS)[number]['key']

/** 扫码产物：业务无关的原始值。本页不解释它，直接交给下游（#70 Transaction Domain）。 */
type ScanResult = { rawValue: string }

/** 相机错误事件 detail：微信只在 errMsg / errSubMsg 里给字符串 */
type CameraErrorDetail = { errMsg?: string; errSubMsg?: string }

/** onScanCode 事件 detail（weapp 的识别结果在 result 字段） */
type ScanCodeDetail = { result?: string }

/** 相机错误 errMsg 命中即视为「用户拒绝授权」，其余按硬件失败处理 */
const AUTH_DENY_PATTERN = /auth|deny|permission|权限/i

/** 导航失败后，同一枚二维码的自动重试冷却时间 */
const SCAN_RETRY_COOLDOWN_MS = 5000

/**
 * 6 个码位的稳定 id：这里「位置即身份」，模块级生成一次，
 * key 用 id 而不是渲染下标（`noArrayIndexKey`）。
 */
const CODE_SLOTS = [0, 1, 2, 3, 4, 5].map((index) => ({ id: `scan-cell-${index}`, index }))

export default function Scan() {
  const [mode, setMode] = useState<Mode>('viewfinder')
  /** 相机是否挂载：卸载 → 重挂是让报过错相机重启的唯一手段 */
  const [cameraOn, setCameraOn] = useState(true)
  /** 相机实例序号：作为 key，换号即整体重挂（报错恢复 / 返回本页防预览冻结） */
  const [cameraEpoch, setCameraEpoch] = useState(0)
  /** 「扫码没成功」面板当前展示的原因（进入面板时一定带一个） */
  const [failureKey, setFailureKey] = useState<ReasonKey>('no-camera')
  /** 手动输入的 6 位码（字符串数组，空位是空串） */
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', ''])
  /** 手动输入的当前焦点格（0~5） */
  const [focus, setFocus] = useState(0)
  const [codeError, setCodeError] = useState(false)

  /** 防重复消费锁：onScanCode 从发起导航到页面隐藏期间为 true */
  const processingRef = useRef(false)
  /** 上一次导航失败的二维码：冷却期内同一枚码不自动重试 */
  const failedScanRef = useRef<{ value: string; at: number } | null>(null)

  const code = digits.join('')
  const ready = code.length === 6

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
   * 复核相机权限（页面显示 / 从设置页回来 / 关闭手动输入时走）。
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
        setMode((prev) => (prev === 'denied' || prev === 'manual' ? 'viewfinder' : prev))
      })
      .catch(() => {
        // getSetting 失败：仍尝试挂相机，授权结果交给 onError 兜底
        setCameraOn(true)
        setMode((prev) => (prev === 'denied' || prev === 'manual' ? 'viewfinder' : prev))
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
   * 扫码结果入口：只取原始字符串交给下游页（#70 接入后在这里换消费方式）。
   * onScanCode 对准期间会连续触发，上锁后同一枚二维码只发起一次导航。
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

  const setDigit = (index: number, value: string) => {
    const clean = value.replace(/\D/g, '')
    setDigits((prev) => {
      const next = [...prev]
      if (clean.length > 1) {
        // 一次粘贴 6 位：从当前格子开始铺开
        clean
          .slice(0, 6 - index)
          .split('')
          .forEach((ch, offset) => {
            next[index + offset] = ch
          })
      } else {
        next[index] = clean
      }
      return next
    })
    setCodeError(false)
    if (clean) setFocus(Math.min(5, index + 1))
  }

  /** 提交：真实实现调后端核销；这里只做「码是否可能有效」的展示反馈 */
  const submitCode = () => {
    if (!ready) return
    // 码校验由后端做（一次性 token）；前端不假装能判断对错，
    // 只在明显不合规（非 6 位纯数字）时给出错误态
    if (!/^\d{6}$/.test(code)) {
      setCodeError(true)
      return
    }
    void Taro.showToast({ title: '交易码校验待接入', icon: 'none' })
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

  /** 关闭手动输入弹层：立即离开，落点由权限复核决定（可能仍在「无权限」） */
  const closeManual = () => {
    setMode('viewfinder')
    syncCameraState()
  }

  return (
    <View className="scan">
      {/* ------- 取景底：原生相机（取景态）/ 有意让位（手输弹层）/ 无相机占位 ------- */}
      <View className="scan__view">
        {cameraOn && mode !== 'manual' ? (
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
        ) : mode === 'manual' ? null : (
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

      {/* 取景框：仅取景 / 手动输入 / 错误列表时可见 */}
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

      {/* ---------------- 底部：手动输入入口（取景态） ---------------- */}
      {mode === 'viewfinder' ? (
        <View className="scan__manualbar">
          <View className="scan__btn-manual" onClick={() => setMode('manual')}>
            <Image className="scan__btn-manual-ic" src={ICONS.key} mode="aspectFit" />
            <Text>手动输入交易码</Text>
          </View>
          <Text className="scan__manual-note num">对方没有二维码 / 相机不可用时用这里</Text>
        </View>
      ) : null}

      {/* ---------------- 手动输入底部弹层（稿子第 02 帧） ---------------- */}
      {mode === 'manual' ? (
        <>
          <View className="scan__scrim" onClick={closeManual} />
          <View className="scan__sheet">
            <View className="scan__grab" />
            <Text className="scan__sheet-title">手动输入交易码</Text>
            <Text className="scan__sheet-sub">输入对方手机上显示的 6 位数字</Text>

            <View className="scan__cells">
              {CODE_SLOTS.map((slot) => {
                const digit = digits[slot.index] ?? ''
                return (
                  <View
                    key={slot.id}
                    className={`scan__cell${slot.index === focus ? ' is-focus' : ''}${
                      codeError ? ' is-err' : ''
                    }${digit ? '' : ' is-dim'}`}
                    onClick={() => setFocus(slot.index)}
                  >
                    <Text className="scan__cell-tx">{digit || '–'}</Text>
                  </View>
                )
              })}
            </View>

            {/* 视觉上是 6 格，真实输入靠这一个透明 Input（小程序没有 6 格原生输入框） */}
            <Input
              className="scan__hidden-input"
              type="number"
              value={''}
              focus
              maxlength={6}
              onInput={(event) => setDigit(focus, event.detail.value)}
            />

            {codeError ? (
              <View className="scan__inline-err">
                <Image className="scan__inline-err-ic" src={ICONS.warn} mode="aspectFit" />
                <Text>码错误 · 请核对后重新输入</Text>
              </View>
            ) : null}

            <View className={`scan__btn-main${ready ? '' : ' is-off'}`} onClick={submitCode}>
              <Text>确认</Text>
            </View>

            <Text className="scan__tip">
              凑够 6 位才可提交；交易码一次性有效，提交成功即成交，重复提交不会重复成交。
            </Text>
          </View>
        </>
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
              去「设置」允许使用相机后即可扫码。不想开权限也可以直接手动输入对方的 6 位交易码。
            </Text>
            <View className="scan__cacts">
              <View className="scan__btn-main scan__btn-main--flat" onClick={openSetting}>
                <Text>去设置</Text>
              </View>
              <View className="scan__btn-ghost" onClick={() => setMode('manual')}>
                <Image className="scan__btn-ghost-ic" src={ICONS.key} mode="aspectFit" />
                <Text>手动输入交易码</Text>
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
                    if (item.action === 'manual') {
                      setMode('manual')
                    } else {
                      // retry / dismiss 都回取景：相机若已卸下会重挂（错误过的实例不会自愈）
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
