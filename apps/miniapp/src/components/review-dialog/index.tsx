import {
  MAX_REVIEW_IMAGES,
  REVIEW_BODY_MAX,
  type TransactionReviewRating,
} from '@fish/contracts/transaction-reviews/schema'
import { Image, Text, Textarea, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import { useAuth } from '@/features/auth/store'
import { createTransactionReview } from '@/features/transaction/api'
import {
  appendWithinLimit,
  type ReviewImageSlot,
  reviewSubmitBlockedReason,
  uploadedObjectKeys,
} from '@/features/transaction/review-form'
import { type ReviewPhoto, uploadReviewImage } from '@/features/transaction/review-media'
import { pickPhotos } from '@/features/upload/api'
import { isApiError } from '@/lib/request'
import './index.scss'

/**
 * 评价弹层（订单卡与面交页完成态共用的写入口，#475）。
 *
 * 三档评分（好评 / 中评 / 差评，#195 冻结口径）+ 可空评语 + 配图（最多
 * `MAX_REVIEW_IMAGES` = 3 张）。评语 trim 后为空 = 「只打分没写字」（契约明说的
 * 正常形态），提交时省略字段；配图只收 confirm 固化的 final 键（`review-media.ts`
 * 的上传链），槽位序即 `sort_order`。
 *
 * 配图编排沿用 PC 端 #483 审查响应定下的两条纪律：
 * - **同步权威列表**：`imagesRef` 是唯一真相，每次增删改先写 ref 再进 state ——
 *   并发选图 / 连续移除的渲染窗口里 state 是旧值，槽位判断会超订、移除会复活条目；
 * - **原子槽位预留**：满槽时 `appendWithinLimit` 返回 null，绝不为它发起上传
 *   （否则 confirm 出一个没有任何条目可挂的孤儿对象）。
 *
 * 上传中的关闭/移除：`uploadReviewImage` 在每一步发请求前问 `isActive`，
 * 弹层卸载（`aliveRef`）或条目被移除后立刻中止 —— staging 侧的残留对象由 #476
 * 的孤儿回收兜底，与 PC 端 abort 的语义一致。
 */

/** 评价的三档（#195 冻结口径：好评 / 中评 / 差评，不是 1–5 星）；订单卡的内联表单已随 #475 下沉到本组件 */
const REVIEW_TIERS: { key: TransactionReviewRating; label: string }[] = [
  { key: 'POSITIVE', label: '好评' },
  { key: 'NEUTRAL', label: '中评' },
  { key: 'NEGATIVE', label: '差评' },
]

/** 槽位 id 的会话内自增序号（页面级组件，无需跨启动稳定） */
let slotSeq = 0

type Props = {
  /** 上传链与评价边的授权锚点：`(transactionId, 我)` 就是评价边本身 */
  transactionId: string
  /** 弹层副标题：这笔交易对应的商品标题 */
  listingTitle: string
  /** 关闭弹层。提交中的关闭由组件内部挡下（busy 守卫），父级不必再判 */
  onClose: () => void
  /** 提交成功（已 toast「评价已提交」）。父级据此刷新权威状态并收起弹层 */
  onSubmitted: () => void
}

export default function ReviewDialog({ transactionId, listingTitle, onClose, onSubmitted }: Props) {
  const [tier, setTier] = useState<TransactionReviewRating | null>(null)
  const [body, setBody] = useState('')
  const [images, setImages] = useState<ReviewImageSlot[]>([])
  const [busy, setBusy] = useState(false)
  /** 同步权威列表：先写 ref 再进 state（见文件头） */
  const imagesRef = useRef<ReviewImageSlot[]>([])
  /** 卸载哨兵：关层后在途上传的迟到结果不再发后续请求 */
  const aliveRef = useRef(true)
  /** 上传链所属的账号（第一次选图时铸定）：每一步发请求前都要求身份未变（#170/#208 口径） */
  const { user } = useAuth()
  const ownerRef = useRef<string | null>(null)
  /** 原生选图面板的在飞哨：连点加图位不并发第二扇 */
  const pickingRef = useRef(false)
  useEffect(() => {
    return () => {
      aliveRef.current = false
    }
  }, [])

  const commitImages = (next: ReviewImageSlot[]) => {
    imagesRef.current = next
    setImages(next)
  }

  /** 槽位还在表里、身份未变、仍是「上传中」才算数 —— 移除/换号后的迟到结果一律丢弃 */
  const slotActive = (id: string) =>
    aliveRef.current &&
    (ownerRef.current === null || user?.id === ownerRef.current) &&
    imagesRef.current.some((slot) => slot.id === id)

  const runUpload = (id: string, photo: ReviewPhoto) => {
    return uploadReviewImage(transactionId, photo, () => slotActive(id))
      .then((objectKey) => {
        if (!slotActive(id)) return
        commitImages(
          imagesRef.current.map((slot) =>
            slot.id === id ? { ...slot, status: 'uploaded', objectKey, error: null } : slot,
          ),
        )
      })
      .catch((caught: unknown) => {
        // 条目已移除 / 弹层已关：上传链已在下一步边界自停，这里不再写任何状态
        if (!slotActive(id)) return
        commitImages(
          imagesRef.current.map((slot) =>
            slot.id === id
              ? {
                  ...slot,
                  status: 'failed',
                  objectKey: null,
                  error: caught instanceof Error ? caught.message : '图片上传失败，请重试',
                }
              : slot,
          ),
        )
      })
  }

  /** 选图（最多补满剩余槽位）→ 逐张独立上传。取消是正常路径；权限失败给可重试文案。 */
  const addImages = () => {
    const room = MAX_REVIEW_IMAGES - imagesRef.current.length
    if (room <= 0 || busy) return
    if (pickingRef.current) return // 原生选图面板还开着：连点不并发第二扇
    pickingRef.current = true
    if (ownerRef.current === null) ownerRef.current = user?.id ?? null
    void pickPhotos(room)
      .then(({ photos, rejected }) => {
        if (rejected !== null) void Taro.showToast({ title: rejected, icon: 'none' })
        for (const photo of photos) {
          slotSeq += 1
          const entry: ReviewImageSlot = {
            id: `rvw-img-${slotSeq}`,
            path: photo.path,
            mime: photo.mime,
            sizeBytes: photo.sizeBytes,
            status: 'uploading',
            objectKey: null,
            error: null,
          }
          // 原子预留：满槽（并发选图窗口）直接跳过，不开上传
          const next = appendWithinLimit(imagesRef.current, entry, MAX_REVIEW_IMAGES)
          if (next === null) continue
          commitImages(next)
          void runUpload(entry.id, photo)
        }
      })
      .catch((caught: unknown) => {
        void Taro.showToast({
          title: caught instanceof Error ? caught.message : '无法选择图片，请重试',
          icon: 'none',
        })
      })
      .finally(() => {
        pickingRef.current = false
      })
  }

  const removeImage = (id: string) => {
    if (busy) return
    commitImages(imagesRef.current.filter((slot) => slot.id !== id))
  }

  const retryImage = (id: string) => {
    if (busy) return
    const slot = imagesRef.current.find((item) => item.id === id)
    if (slot?.status !== 'failed') return
    commitImages(
      imagesRef.current.map((item) =>
        item.id === id ? { ...item, status: 'uploading', error: null } : item,
      ),
    )
    void runUpload(id, { path: slot.path, mime: slot.mime, sizeBytes: slot.sizeBytes })
  }

  /** 提交。有在途 / 失败的配图时不许提交（闸门文案给 toast，不许静默丢图）。 */
  const submit = () => {
    if (busy) return
    if (tier === null) {
      void Taro.showToast({ title: '请先选好评 / 中评 / 差评', icon: 'none' })
      return
    }
    const blocked = reviewSubmitBlockedReason(imagesRef.current)
    if (blocked !== null) {
      void Taro.showToast({ title: blocked, icon: 'none' })
      return
    }
    setBusy(true)
    const trimmed = body.trim()
    const imageObjectKeys = uploadedObjectKeys(imagesRef.current)
    createTransactionReview(transactionId, {
      rating: tier,
      ...(trimmed === '' ? {} : { body: trimmed }),
      ...(imageObjectKeys.length > 0 ? { imageObjectKeys } : {}),
    })
      .then(() => {
        void Taro.showToast({ title: '评价已提交', icon: 'none' })
        onSubmitted()
      })
      .catch((caught: unknown) => {
        // 422 REVIEW_CONTENT_BLOCKED / REVIEW_IMAGE_INVALID / 409 已评过等服务端文案原样透出
        void Taro.showToast({
          title: isApiError(caught) ? caught.message : '提交没成功，请重试',
          icon: 'none',
        })
      })
      .finally(() => {
        if (aliveRef.current) setBusy(false)
      })
  }

  const close = () => {
    if (busy) return
    onClose()
  }

  const full = images.length >= MAX_REVIEW_IMAGES

  return (
    <>
      <View className="rvw__scrim" onClick={close} />
      <View className="rvw__dialog">
        <Text className="rvw__title">评价这笔交易</Text>
        <Text className="rvw__sub">{listingTitle}</Text>
        <View className="rvw__tiers">
          {REVIEW_TIERS.map((item) => (
            <View
              key={item.key}
              className={`rvw__tier rvw__tier--${item.key.toLowerCase()}${
                tier === item.key ? ' is-on' : ''
              }`}
              onClick={() => setTier(item.key)}
            >
              <Text>{item.label}</Text>
            </View>
          ))}
        </View>
        <View className="rvw__bodywrap">
          <Textarea
            className="rvw__body"
            maxlength={REVIEW_BODY_MAX}
            placeholder="写点想说的（可不填，最多 200 字）"
            value={body}
            onInput={(event) => setBody(event.detail.value)}
          />
        </View>

        {/*
          配图槽位（出物页同款视觉语言）：缩略图 + 左上状态角标（上传中 / 重传）+
          右上删除钮；未满槽时补一块虚线加图位。
        */}
        <View className="rvw__photos">
          {images.map((slot) => (
            <View key={slot.id} className="rvw__photo">
              <Image className="rvw__photo-img" src={slot.path} mode="aspectFill" />
              {slot.status === 'uploaded' ? null : (
                <Text
                  className={`rvw__photo-flag${slot.status === 'failed' ? ' is-err' : ''}`}
                  onClick={slot.status === 'failed' ? () => retryImage(slot.id) : undefined}
                >
                  {slot.status === 'failed' ? '重传' : '上传中'}
                </Text>
              )}
              <View className="rvw__photo-del" onClick={() => removeImage(slot.id)}>
                <Image className="rvw__photo-del-img" src={ICONS.delete} mode="aspectFit" />
              </View>
            </View>
          ))}
          {full ? null : (
            <View className="rvw__photo rvw__photo--add" onClick={addImages}>
              <Image className="rvw__photo-add-img" src={ICONS.plusLine} mode="aspectFit" />
            </View>
          )}
        </View>
        <Text className="rvw__pnote">
          {`配图（可选）· 最多 ${MAX_REVIEW_IMAGES} 张 · JPG / PNG / WebP，单张不超过 5MB`}
        </Text>

        <View className="rvw__acts">
          <View className="rvw__cancel" onClick={close}>
            <Text>再想想</Text>
          </View>
          <View className={`rvw__ok${tier === null ? ' is-off' : ''}`} onClick={submit}>
            <Text>{busy ? '提交中…' : '提交评价'}</Text>
          </View>
        </View>
      </View>
    </>
  )
}
