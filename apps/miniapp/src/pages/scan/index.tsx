import { Image, Input, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import './index.scss'

/**
 * C6 扫码（设计稿 `设计稿_C6-scan.html`）。
 *
 * 全屏深色取景页：半透明遮罩 + 中间透明取景框 + 四角描边 + 扫描线，
 * 顶部漂浮返回钮与标题，下方提示文案，底部「手动输入交易码」入口。
 *
 * **手动输入是必备 fallback**（稿子第 02 帧）：无法开相机 / 没有摄像头 / 对方没有二维码
 * 时都用它。6 格输入 + 错误态 + 凑够 6 位才能提交。
 *
 * **实现约定**
 * - 调 `Taro.scanCode` 这个**原生能力**，不引 `BarcodeDetector`（小程序没有）。
 * - 扫码结果**只当作原始字符串**。本页**不解析、不写交易逻辑**：识别到内容后
 *   把字符串交给 A2（交易码页）继续，避免两处各写一套码校验。
 * - 错误按原因给不同出口（硬件 / 解析 / 无效 / 过期），不让用户卡在同一个按钮上。
 *
 * **与后端的边界**：交易码是**短期一次性 token**，由后端签发（#70 / PR #83 未合）。
 * 所以这里既不发明 `challengeId` 之类字段，也不做「码对不对」的判定——
 * 校验失败的文案是给用户看的反馈，不是校验逻辑。
 */

/** 结果反馈的四种原因（稿子第 04 帧） */
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

export default function Scan() {
  const [mode, setMode] = useState<Mode>('viewfinder')
  /** 手动输入的 6 位码（字符串数组，空位是空串） */
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', ''])
  /** 手动输入的当前焦点格（0~5） */
  const [focus, setFocus] = useState(0)
  const [codeError, setCodeError] = useState(false)

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
   * 扫码：结果只透传。
   *
   * `scanCode` 的失败原因（相机权限被拒 / 没有相机）直接决定落到哪个错误态，
   * 而不是笼统地弹一句「扫码失败」——这是本页能被读懂的关键。
   */
  const startScan = () => {
    setMode('viewfinder')
    void Taro.scanCode({ scanType: ['qrCode'] })
      .then((res) => {
        const raw = res.result ?? ''
        if (!raw) {
          setMode('errors')
          return
        }
        // 只把原始字符串交给交易码页，扫码页不解析码的含义
        void Taro.navigateTo({
          url: `/pages/transaction-meetup/index?code=${encodeURIComponent(raw)}`,
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        // 权限相关走「无权限」引导；其余（无摄像头 / 被占用）落到结果反馈
        setMode(/auth|deny|permission|权限/i.test(message) ? 'denied' : 'errors')
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
    void Taro.openSetting({}).catch(() => undefined)
  }

  return (
    <View className="scan">
      {/* ---------------- 取景底：相机预览位（真实实现是 camera 组件） ---------------- */}
      <View className="scan__view">
        <Text className="scan__view-label num">CAMERA PREVIEW PLACEHOLDER</Text>
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
          <View className="scan__scrim" onClick={() => setMode('viewfinder')} />
          <View className="scan__sheet">
            <View className="scan__grab" />
            <Text className="scan__sheet-title">手动输入交易码</Text>
            <Text className="scan__sheet-sub">输入对方手机上显示的 6 位数字</Text>

            <View className="scan__cells">
              {digits.map((digit, index) => (
                <View
                  key={`cell-${index}`}
                  className={`scan__cell${index === focus ? ' is-focus' : ''}${
                    codeError ? ' is-err' : ''
                  }${digit ? '' : ' is-dim'}`}
                  onClick={() => setFocus(index)}
                >
                  <Text className="scan__cell-tx">{digit || '–'}</Text>
                </View>
              ))}
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

            <View
              className={`scan__btn-main${ready ? '' : ' is-off'}`}
              onClick={submitCode}
            >
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
              去「设置」允许使用相机后即可扫码。不想开权限也可以直接手动输入对方的 6
              位交易码。
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

      {/* ---------------- 「扫码没成功」结果反馈（稿子第 04 帧） ---------------- */}
      {mode === 'errors' ? (
        <View className="scan__sheet scan__sheet--list">
          <View className="scan__grab" />
          <Text className="scan__sheet-title scan__sheet-title--left">扫码没成功</Text>
          <Text className="scan__sheet-sub scan__sheet-sub--left">
            按原因给不同出口，不让用户卡在同一个按钮上
          </Text>

          <View className="scan__reasons">
            {REASONS.map((item) => (
              <View key={item.key} className="scan__frow">
                <Text className={`scan__pipe ${item.pipeCls}`}>{item.pipe}</Text>
                <View className="scan__fmain">
                  <Text className="scan__ft">{item.title}</Text>
                  <Text className="scan__fd">{item.desc}</Text>
                </View>
                <View
                  className="scan__fact"
                  onClick={() => {
                    if (item.action === 'manual') setMode('manual')
                    else if (item.action === 'retry') startScan()
                    else setMode('viewfinder')
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
