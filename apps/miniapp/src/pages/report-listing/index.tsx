import { Image, Text, Textarea, View } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import NavBar from '@/components/nav-bar'
import { DEMO_AUTH_ENABLED } from '@/features/auth/demo'
import { useAuthGuard } from '@/features/auth/guard'
import { MOCK_FALLBACK_ENABLED } from '@/features/load-failure'
import {
  DEMO_SUBMITTED_REPORT_ID,
  findDemoReport,
  rememberDemoReport,
} from '@/features/reports/demo'
import {
  bannerCopy,
  REPORT_DESC_DEFAULT_HINT,
  REPORT_STATUS_META,
  reasonHint,
  reasonLabel,
  reasonsOf,
} from '@/features/reports/meta'
import { readNavMetrics } from '@/lib/nav-metrics'
import './index.scss'

/**
 * 举报商品（稿 `小程序1版举报商品.html`）。
 *
 * ## 两张独立页面，互不相通（Owner 2026-09-26 拍板）
 *
 * 举报商品（本页，入口：商品详情「举报商品」）与举报用户（`pages/report-user`）是两张
 * 独立页面：各自持有对象形态、原因胶囊与文案，互不跳转。两页只共用
 * `features/reports` 里的枚举 / 状态 / 文案常量（#252 冻结的那部分），页面结构互不复用。
 *
 * ## 同一页面的两种形态（入口 query 决定，页内不切换）
 *
 * - **新建**：商品详情带 `id / title / price / cover` 进入。对象卡固定不可改 ——
 *   防止拿别人的资源 id 拼举报；商品编号不在页内展示（#217 拍板「详情页不常驻展示编号」）。
 * - **只读**：「我的举报」点卡片带 `reportId` 进入 —— 按该条记录的状态渲染
 *   审核中 / 已处理 / 已驳回横幅 + 内容卡（编号可复制，给客服对账用）。
 *   `reportId` 对不上演示数据时（真机直开 / 数据被清）退回新建态，不渲染半张详情卡。
 *
 * ## 没有后端时的口径（与 `pages/favorites` / `pages/comments` 同一体系）
 *
 * main 还没有 `POST /reports`（#252 的后端在 Draft PR #231/#240/#241）：
 * - **真实构建**：提交按钮如实告知后端未上线，**不假成功、不写本地**（#193 同款要求）；
 * - **演示构建**（`TARO_APP_MOCK=1`）：提交走 700ms 模拟时延落到成功态，成功态标明
 *   是演示提交，并把记录追加进进程内存（`features/reports/demo`），让
 *   「提交 → 查看我的举报 → 点进详情」动线能走通；重启即消失。
 *
 * ## 顶部栏（吸顶口径）
 *
 * 二级页拍板形态：`NavBar glass` —— `position: fixed` 的玻璃底 + 居中双色标题 +
 * 裸返回钮，**常驻吸顶**（表单滚动时标题栏不动，页头渐变随内容滚走）。
 * 内容顶部用 `readNavMetrics().totalHeight` 让出栏高（`pages/user` 同款做法）。
 *
 * ## 鉴权
 *
 * 挂 `useAuthGuard()`：确定未登录时自动 redirectTo 登录页（#252「未登录引导登录」），
 * `unknown`（冷启动恢复中）渲染占位、不发任何东西。
 */

const REASONS = reasonsOf('LISTING')
const REASON_MAX = 200
/** 演示构建口径：mock 回退与演示登录态**都要**开（只认 MOCK_FALLBACK 会顶掉 dev:weapp 的真实空态） */
const DEMO_MODE = MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED

export default function ReportListing() {
  const authStatus = useAuthGuard()
  /** 路由参数读一次：两种入口都靠 query 定形态，页内不切换（跳转都是重新开页） */
  const { params } = useRouter()
  const reportId = params.reportId ?? null
  /** 只读态的记录来自演示数据 */
  const viewRecord = reportId !== null ? findDemoReport(reportId) : null
  const mode: 'fill' | 'view' = reportId !== null && viewRecord !== null ? 'view' : 'fill'

  /** 新建态的举报对象（商品详情带入，页内不可改） */
  const target = {
    title: params.title ?? '',
    price: params.price ?? '',
    cover: params.cover ?? '',
  }

  const [chosen, setChosen] = useState<string | null>(null)
  const [desc, setDesc] = useState('')
  const [typeErr, setTypeErr] = useState(false)
  const [fieldFocus, setFieldFocus] = useState(false)
  /** 提交在飞：防重复提交（#252） */
  const [busy, setBusy] = useState(false)
  /** null = 还在表单；非 null = 成功态已落定（整页切换，不再回到表单） */
  const [done, setDone] = useState<{ reason: string; desc: string } | null>(null)

  const navTotalHeight = readNavMetrics().totalHeight

  const toast = (title: string) => {
    void Taro.showToast({ title, icon: 'none' })
  }

  const chosenHint = reasonHint('LISTING', chosen)

  const copyId = (id: string) => {
    void Taro.setClipboardData({ data: id })
    // 微信会在复制成功后弹自己的「内容已复制」提示，这里不再叠一层 toast
  }

  const submit = () => {
    if (busy || done !== null) return
    if (chosen === null) {
      setTypeErr(true)
      toast('请先选择举报类型')
      return
    }
    // 真实构建：不假成功（#193 同款）。后端在 Draft PR（#231/#240/#241），合并后把
    // 这一段换成真实 POST /reports（created:true/false 分别落「已受理/此前已受理」）。
    if (!DEMO_MODE) {
      toast('举报提交还没有后端，等功能上线后再来')
      return
    }
    setBusy(true)
    setTimeout(() => {
      setBusy(false)
      setDone({ reason: chosen, desc: desc.trim() })
      // 演示「落库」：追加进进程内存，让「我的举报」列表与只读态都能看到这条（见 demo.ts 文件头）
      rememberDemoReport({
        id: DEMO_SUBMITTED_REPORT_ID,
        target: 'LISTING',
        objTitle: target.title || '（未带出商品标题）',
        objPrice: target.price || null,
        reason: chosen,
        desc: desc.trim(),
        timeLabel: '刚刚',
        status: 'PENDING',
      })
    }, 700)
  }

  /** 成功态主按钮：用 redirectTo 把表单页换成列表页（返回键回到商品详情，栈不加深） */
  const goMyReports = () => {
    void Taro.redirectTo({ url: '/pages/my-reports/index' })
  }

  const navTitle = (
    <Text>
      举报
      <Text className="rpl__navem">{mode === 'view' ? '详情' : '商品'}</Text>
    </Text>
  )

  /* ── 键值行：成功态「提交内容」与只读态「举报内容」共用同一套结构 ── */
  const rowsOf = (data: {
    objTitle: string
    objPrice: string | null
    cover: string
    reason: string
    desc: string
    timeLabel: string
    id: string
  }) => (
    <>
      <View className="rpl__kvobj">
        {data.cover ? (
          <Image className="rpl__obj-img rpl__obj-img--sm" src={data.cover} mode="aspectFill" />
        ) : (
          <View className="rpl__obj-ph rpl__obj-ph--sm">
            <Image className="rpl__obj-ph-ic" src={ICONS.imageMuted} mode="aspectFit" />
          </View>
        )}
        <View className="rpl__obj-main">
          <Text className="rpl__obj-name">{data.objTitle}</Text>
          {data.objPrice ? (
            <Text className="rpl__obj-sub">
              <Text className="rpl__obj-price">{`¥${data.objPrice}`}</Text>
            </Text>
          ) : null}
        </View>
      </View>
      <View className="rpl__kv">
        <Text className="rpl__kv-k">举报类型</Text>
        <View className="rpl__kv-v">
          <Text className="rpl__rtag">{reasonLabel('LISTING', data.reason)}</Text>
        </View>
      </View>
      <View className="rpl__kv">
        <Text className="rpl__kv-k">补充说明</Text>
        <Text className={`rpl__kv-v${data.desc ? '' : ' is-dim'}`}>{data.desc || '未填写'}</Text>
      </View>
      <View className="rpl__kv">
        <Text className="rpl__kv-k">提交时间</Text>
        <Text className="rpl__kv-v num">{data.timeLabel}</Text>
      </View>
      <View className="rpl__kv">
        <Text className="rpl__kv-k">举报编号</Text>
        <View className="rpl__kvid">
          <Text className="rpl__kv-v num">{data.id}</Text>
          <View className="rpl__copy" onClick={() => copyId(data.id)}>
            <Text>复制</Text>
          </View>
        </View>
      </View>
    </>
  )

  return (
    <View className="rpl">
      <NavBar glass titleAlign="center" title={navTitle} />
      {/* 玻璃栏是 fixed：内容让出栏高（状态栏 + 导航行，设备 px，见 nav-metrics.ts） */}
      <View style={{ height: `${navTotalHeight}px` }} />

      {authStatus !== 'authed' ? (
        <View className="rpl__auth">
          <AuthRequired restoring={authStatus === 'unknown'} />
        </View>
      ) : mode === 'view' && viewRecord !== null ? (
        /* ═══ 只读态：审核中 / 已处理 / 已驳回（入口：「我的举报」点卡片） ═══ */
        <View className="rpl__content">
          <View className={`rpl__banner is-${REPORT_STATUS_META[viewRecord.status].tone}`}>
            <Image
              className="rpl__banner-ic"
              src={
                viewRecord.status === 'HANDLED'
                  ? ICONS.checkAccent
                  : viewRecord.status === 'REJECTED'
                    ? ICONS.warnInk
                    : ICONS.clockInk
              }
              mode="aspectFit"
            />
            <View className="rpl__banner-main">
              <Text className="rpl__banner-t">{bannerCopy(viewRecord.status).title}</Text>
              <Text className="rpl__banner-s">{bannerCopy(viewRecord.status).text}</Text>
            </View>
          </View>

          <View className="rpl__card">
            <View className="rpl__card-hd">
              <Text className="rpl__card-h2">举报内容</Text>
            </View>
            {rowsOf({
              objTitle: viewRecord.objTitle,
              objPrice: viewRecord.objPrice,
              cover: '',
              reason: viewRecord.reason,
              desc: viewRecord.desc,
              timeLabel: viewRecord.timeLabel,
              id: viewRecord.id,
            })}
          </View>

          {DEMO_MODE ? (
            <Text className="rpl__demonote">演示记录：来自演示构建的样例数据。</Text>
          ) : null}

          <View className="rpl__acts">
            <View className="rpl__btn-ghost" onClick={() => void Taro.navigateBack()}>
              <Text>返回「我的举报」</Text>
            </View>
          </View>
        </View>
      ) : done !== null ? (
        /* ═══ 成功态（02）：不 toast 了事，整页落成功并给「我的举报」动线 ═══ */
        <View className="rpl__content">
          <View className="rpl__hero">
            <View className="rpl__hero-ic">
              <Image className="rpl__hero-ic-img" src={ICONS.checkAccent} mode="aspectFit" />
            </View>
            <Text className="rpl__hero-t">举报已提交</Text>
            <Text className="rpl__hero-s">
              平台会在核实后处理，处理结果可在「我的举报」中查看。
            </Text>
          </View>

          <View className="rpl__card">
            <View className="rpl__card-hd">
              <Text className="rpl__card-h2">提交内容</Text>
            </View>
            {rowsOf({
              objTitle: target.title || '（未带出商品标题）',
              objPrice: target.price || null,
              cover: target.cover,
              reason: done.reason,
              desc: done.desc,
              timeLabel: '刚刚',
              id: DEMO_SUBMITTED_REPORT_ID,
            })}
          </View>

          {DEMO_MODE ? (
            <Text className="rpl__demonote">
              演示提交：举报后端还没上线（#252），这条记录没有真的保存。
            </Text>
          ) : null}

          <View className="rpl__acts">
            <View className="rpl__btn-primary" onClick={goMyReports}>
              <Text>查看「我的举报」</Text>
            </View>
            <View className="rpl__btn-ghost" onClick={() => void Taro.navigateBack()}>
              <Text>返回商品详情</Text>
            </View>
          </View>
        </View>
      ) : (
        /* ═══ 新建态（01）：入口 = 商品详情「举报商品」 ═══ */
        <View className="rpl__content">
          <View className="rpl__head">
            <View className="rpl__kicker">
              <Image className="rpl__kicker-ic" src={ICONS.shieldLine} mode="aspectFit" />
              <Text>Report · 举报商品</Text>
            </View>
            <Text className="rpl__title">举报这个商品</Text>
            <Text className="rpl__sub">
              平台会在核实后处理被举报商品，处理进度与结果可以在「我的举报」中查看。
            </Text>
          </View>

          <View className="rpl__card">
            <View className="rpl__card-hd">
              <Text className="rpl__card-h2">举报对象</Text>
              <Text className="rpl__opt">由入口带入</Text>
            </View>
            <Text className="rpl__card-sub">对象来自你点击「举报」的商品详情页，不能修改。</Text>
            <View className="rpl__obj">
              {target.cover ? (
                <Image className="rpl__obj-img" src={target.cover} mode="aspectFill" />
              ) : (
                <View className="rpl__obj-ph">
                  <Image className="rpl__obj-ph-ic" src={ICONS.imageMuted} mode="aspectFit" />
                </View>
              )}
              <View className="rpl__obj-main">
                <Text className="rpl__obj-name">{target.title || '（未带出商品标题）'}</Text>
                <Text className="rpl__obj-sub">
                  {target.price ? (
                    <Text className="rpl__obj-price">{`¥${target.price}`}</Text>
                  ) : null}
                  {' · 由商品详情带入'}
                </Text>
              </View>
              <Text className="rpl__obj-tag">不可修改</Text>
            </View>
          </View>

          <View className={`rpl__card${typeErr ? ' is-err' : ''}`}>
            <View className="rpl__card-hd">
              <Text className="rpl__card-h2">举报类型</Text>
              <Text className="rpl__req">*</Text>
              <Text className="rpl__opt">必填</Text>
            </View>
            <Text className="rpl__card-sub">选择最接近的一项，平台会按类型核查。</Text>
            <View className="rpl__pills">
              {REASONS.map((reason) => (
                <View
                  key={reason.key}
                  className={`rpl__pill${chosen === reason.key ? ' is-on' : ''}`}
                  onClick={() => {
                    setChosen(reason.key)
                    setTypeErr(false)
                  }}
                >
                  <Text>{reason.label}</Text>
                </View>
              ))}
            </View>
            {typeErr ? (
              <View className="rpl__err">
                <Text>请先选择举报类型</Text>
              </View>
            ) : null}
          </View>

          <View className="rpl__card">
            <View className="rpl__card-hd">
              <Text className="rpl__card-h2">补充说明</Text>
              <Text className="rpl__opt">选填 · 最多 200 字</Text>
            </View>
            <Text className="rpl__card-sub">
              {chosenHint ?? '补充时间、对方言行等细节，能让核查更快。'}
            </Text>
            <View className={`rpl__field${fieldFocus ? ' is-focus' : ''}`}>
              <Textarea
                className="rpl__ta"
                value={desc}
                maxlength={REASON_MAX}
                placeholder={chosenHint ?? REPORT_DESC_DEFAULT_HINT}
                onInput={(e) => setDesc(e.detail.value)}
                onFocus={() => setFieldFocus(true)}
                onBlur={() => setFieldFocus(false)}
              />
              <View className="rpl__fieldfoot">
                <Text className="rpl__kb">最多 200 字</Text>
                <Text className="rpl__count num">{`${desc.length} / ${REASON_MAX}`}</Text>
              </View>
            </View>
          </View>

          <View className="rpl__note">
            <Image className="rpl__note-ic" src={ICONS.shieldLine} mode="aspectFit" />
            <Text className="rpl__note-tx">
              提交后平台会核查被举报内容；恶意举报可能影响你的账号信用。
            </Text>
          </View>

          <View
            className={`rpl__submit${chosen !== null && !busy ? '' : ' is-off'}`}
            onClick={submit}
          >
            <Text>{busy ? '提交中…' : '提交举报'}</Text>
          </View>
          <Text className="rpl__formfoot">重复举报不会加快处理 · 结果请在「我的举报」查看</Text>
        </View>
      )}
    </View>
  )
}
