/**
 * 编辑资料（#86 B 线）：改微信头像与昵称。
 *
 * 头像只能走微信还开放的 `open-type="chooseAvatar"`（`getUserInfo` / `getUserProfile`
 * 已分别于 2021-04-13 / 2022-10-25 下线），昵称走 `<input type="nickname">`；
 * 两者给的都是**本地临时路径 / 文本**，落库前要自己走完两段：
 *   头像：选文件 → presign → 直传对象存储 → confirm（复用 `uploadListingImage`）
 *         → `PATCH /profile { avatarObjectKey }`（服务端只认本账号前缀的 objectKey）
 *   昵称：直接 `PATCH /profile { nickname }`，不碰上传域
 *
 * 本页不做「未完成态强制补全」（Owner 裁定）：微信用户建号时带占位昵称，改不改由用户自己决定。
 *
 * 隐私前置（外部、代码改不了）：小程序要在「mp 后台 → 设置 → 服务内容声明 → 用户隐私保护指引」
 * 里声明头像等收集类型；没声明时微信不做隐私检查，声明了才会弹授权弹窗（见 `@/lib/privacy`）。
 */
import { Button, Image, Input, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import { useAuthGuard } from '@/features/auth/guard'
import { applyProfile, useAuth } from '@/features/auth/store'
import { updateProfile } from '@/features/profile/api'
import { avatarMime, NICKNAME_MAX } from '@/features/profile/avatar'
import {
  advanceSession,
  isTicketCurrent,
  runProfileSave,
  type SaveTicket,
  type SessionKey,
} from '@/features/profile/save'
import { type PickedPhoto, uploadListingImage, validatePickedSize } from '@/features/upload/api'
import { readNavMetrics } from '@/lib/nav-metrics'
import { ensurePrivacyAuthorized } from '@/lib/privacy'
import { isApiError } from '@/lib/request'
import './index.scss'

/** `onChooseAvatar` 的 `detail` 在 Taro 类型里是 `any`，这里收窄成微信实际给的字段。 */
type ChooseAvatarEvent = { detail: { avatarUrl?: string } }

/**
 * 本地 5MB 预检要的字节数：契约 `UploadPresignRequestSchema` 的 `sizeBytes` 必填，
 * 服务端 confirm 时还会用对象存储的真实大小再复核一次。
 */
function readFileSize(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    Taro.getFileSystemManager().stat({
      path: filePath,
      success: (res) => {
        // 不传 recursive → stats 是单个 Stats；Taro 把它与 IAnyObject 并列，故按形状收窄
        const size = (res.stats as { size?: unknown }).size
        resolve(typeof size === 'number' ? size : 0)
      },
      fail: (res) => reject(new Error(`读取头像文件失败：${res.errMsg}`)),
    })
  })
}

/**
 * 把 `chooseAvatar` 给的临时路径变成上传链要的 `PickedPhoto`。
 * 格式信 `getImageInfo`（真机的临时文件常常没有后缀），拿不到再按后缀兜底。
 */
async function readAvatarPhoto(tempFilePath: string): Promise<PickedPhoto> {
  let type: string | null = null
  try {
    type = (await Taro.getImageInfo({ src: tempFilePath })).type ?? null
  } catch {
    // 取不到图片信息不是致命错误：交给后缀兜底，两边都不认才报文案
  }

  const mime = avatarMime(type, tempFilePath)
  if (!mime) throw new Error('头像仅支持 JPG / PNG / WebP')

  const sizeBytes = await readFileSize(tempFilePath)
  const tooBig = validatePickedSize(sizeBytes)
  if (tooBig) throw new Error(tooBig)

  return { path: tempFilePath, mime, sizeBytes }
}

export default function ProfileEdit() {
  // 受限页：anonymous 时守卫会 redirectTo 登录页，unknown 时先 bootstrap
  useAuthGuard()
  const { user: owner } = useAuth()
  const nav = useMemo(() => readNavMetrics(), [])

  const [nickname, setNickname] = useState(() => owner?.nickname ?? '')
  /** 本次选中的本地临时头像（仅预览） */
  const [avatarPath, setAvatarPath] = useState<string | null>(null)
  /** 上面那张临时头像上传成功后的 objectKey；换了头像就作废 */
  const [uploaded, setUploaded] = useState<{ path: string; objectKey: string } | null>(null)
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'saving'>('idle')
  const [nickErr, setNickErr] = useState<string | null>(null)

  const busy = phase !== 'idle'
  const ownerId = owner?.id ?? null
  const ownerNickname = owner?.nickname ?? null

  /**
   * 会话代次（#86 B 线复评 P1）：换号 / 登出 / 卸载都会让它前进，从而作废在途的保存任务。
   * 必须放 ref —— 在途任务读的是**开任务那一刻**的闭包，只有 ref 能读到最新会话。
   */
  const sessionRef = useRef<SessionKey>({ ownerId, epoch: 0 })
  const ticketSeqRef = useRef(0)
  // 渲染期身份清场：`ownerId` 一变先作废上一轮任务（同 `pages/conversation` 的做法）
  if (sessionRef.current.ownerId !== ownerId) {
    sessionRef.current = advanceSession(sessionRef.current, ownerId)
  }
  // 卸载即作废：迟到的任务不得再 PATCH、弹成功或导航
  useEffect(
    () => () => {
      sessionRef.current = { ...sessionRef.current, epoch: sessionRef.current.epoch + 1 }
    },
    [],
  )

  // 冷启动时 store 先 `unknown` 再 `authed`：拿到用户后灌初值；换账号同理（清掉上一个账号的草稿）
  useEffect(() => {
    if (ownerId === null || ownerNickname === null) return
    setNickname(ownerNickname)
    setAvatarPath(null)
    setUploaded(null)
    // 换号时把阶段收回：上一轮任务的进度条属于上一个账号（它自己回来时已是 aborted）
    setPhase('idle')
  }, [ownerId, ownerNickname])

  // `chooseAvatar` 是隐私接口：进页面先把授权问掉，别等用户点头像那一下才失败（#86 B）
  useEffect(() => {
    void ensurePrivacyAuthorized().then((authorized) => {
      if (!authorized) {
        void Taro.showToast({ title: '需同意隐私保护指引后才能选择头像', icon: 'none' })
      }
    })
  }, [])

  const goBack = () => {
    // 冷启动直接打开本页（分享 / 扫码）时页面栈里没有上一页，兜底回「我的」
    void Taro.navigateBack().catch(() => {
      void Taro.switchTab({ url: '/pages/profile/index' })
    })
  }

  const pickAvatar = (tempFilePath: string) => {
    if (busy) return
    setAvatarPath(tempFilePath)
    setUploaded(null)
    setNickErr(null)
  }

  const save = async () => {
    if (busy || owner === null) return

    // 开任务：把**这一刻**的会话钉进凭据，之后每次发鉴权请求前都会再校验一次
    const ticket: SaveTicket = { ...sessionRef.current, id: ++ticketSeqRef.current }
    setNickErr(null)

    const result = await runProfileSave(
      {
        ticket,
        ownerId: owner.id,
        ownerNickname: owner.nickname,
        draft: { nickname, avatarPath, uploaded },
      },
      {
        readAvatarPhoto,
        uploadAvatar: uploadListingImage,
        patchProfile: updateProfile,
        session: () => sessionRef.current,
        onPhase: setPhase,
        onUploaded: (path, objectKey) => setUploaded({ path, objectKey }),
      },
    )

    // 会话已变 / 页面已卸载：不弹成功、不广播、不导航；阶段由身份清场 effect 复位
    if (result.kind === 'aborted') return

    if (result.kind === 'saved') {
      // 会话里的 user 是全局单例（「我的」页也在读），改完立刻广播，返回即是新值
      applyProfile(result.ownerId, { nickname: result.nickname, avatarUrl: result.avatarUrl })
      void Taro.showToast({ title: '已保存', icon: 'success' })
      goBack()
    } else if (result.kind === 'no-change') {
      void Taro.showToast({ title: '没有需要保存的修改', icon: 'none' })
    } else if (result.kind === 'nickname-invalid') {
      setNickErr(result.message)
    } else if (isApiError(result.error)) {
      // 服务端文案已经可读（图片不属于当前用户 / 图片尚未上传完成 / 昵称不合法…）
      const field = result.error.details?.find((detail) => detail.field === 'nickname')
      if (field) {
        setNickErr(field.message)
      } else {
        void Taro.showToast({ title: result.error.message, icon: 'none' })
      }
    } else {
      // 本地预检抛的文案（格式不支持 / 超过 5MB / 读文件失败）
      const message = result.error instanceof Error ? result.error.message : '保存失败，请稍后重试'
      void Taro.showToast({ title: message, icon: 'none' })
    }

    // 只有仍属当前会话的任务才收回阶段，免得把更新那一轮的进度顶掉
    if (isTicketCurrent(ticket, sessionRef.current)) setPhase('idle')
  }

  const previewSrc = avatarPath ?? owner?.avatarUrl ?? null
  const ctaText = phase === 'uploading' ? '上传头像中…' : phase === 'saving' ? '保存中…' : '保存'

  return (
    <View className="pe">
      <View className="pe__bg" />
      <View className="pe__body" style={{ paddingTop: `${nav.totalHeight}px` }}>
        <View
          className="pe__back"
          style={{ top: `${nav.statusBarHeight + nav.contentHeight / 2}px` }}
          onClick={goBack}
        >
          <Image className="pe__back-ic" src={ICONS.backInk} mode="aspectFit" />
        </View>

        <View className="pe__avatar-wrap">
          <Button
            className="pe__avatar-btn"
            openType="chooseAvatar"
            onChooseAvatar={(event: ChooseAvatarEvent) => {
              const url = event.detail.avatarUrl
              if (url) pickAvatar(url)
            }}
          >
            {previewSrc ? (
              <Image className="pe__avatar-img" src={previewSrc} mode="aspectFill" />
            ) : (
              <Image className="pe__avatar-ph" src={ICONS.user} mode="aspectFit" />
            )}
          </Button>
          <View className="pe__avatar-badge">
            <Image className="pe__avatar-badge-ic" src={ICONS.camera} mode="aspectFit" />
          </View>
        </View>

        <Text className="pe__avatar-hint">点击头像，选择微信头像或从相册上传</Text>

        <View className="pe__card">
          <View className="pe__field">
            <Text className="pe__label">昵称</Text>
            <View className={`pe__input${nickErr ? ' is-error' : ''}`}>
              <Input
                className="pe__val"
                type="nickname"
                maxlength={NICKNAME_MAX}
                value={nickname}
                disabled={busy}
                placeholder="请输入昵称"
                placeholderClass="pe__ph"
                onInput={(event) => {
                  setNickname(event.detail.value)
                  if (nickErr) setNickErr(null)
                }}
              />
            </View>
            {nickErr ? (
              <Text className="pe__err">{nickErr}</Text>
            ) : (
              <Text className="pe__help">1–{NICKNAME_MAX} 个字，公开显示</Text>
            )}
          </View>
        </View>

        <View className={`pe__cta${busy || owner === null ? ' is-off' : ''}`} onClick={save}>
          {busy ? <View className="pe__spin" /> : null}
          <Text>{ctaText}</Text>
        </View>
      </View>
    </View>
  )
}
