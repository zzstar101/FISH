import { Image, Input, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import NavBar from '@/components/nav-bar'
import { productImage } from '@/mock/images'
import './index.scss'

/**
 * 「出物」页。**设计稿没有覆盖这一屏**，所以这里只做「同一套设计语言下的最小可用发布表单」：
 * 图片位 / 标题 / 描述 / 价格 / 成色 / 分类，字段与 `listings` 写契约的
 * `ListingCreateInput`（title / description / priceCents / category / condition / free）一一对应。
 *
 * 明确不做（避免假装已实现）：真实图片上传、presign、Moderation 审核反馈、AI 润色。
 * 提交只做前端校验 + toast，不写任何后端。
 */
const CONDITIONS: { key: 'NEW' | 'LIKE_NEW' | 'GOOD' | 'FAIR'; label: string }[] = [
  { key: 'NEW', label: '全新' },
  { key: 'LIKE_NEW', label: '九成新' },
  { key: 'GOOD', label: '八成新' },
  { key: 'FAIR', label: '七成新' },
]

/** 演示用的「已选图片」：真实上传接好后换成用户选择的本地路径 */
const DEMO_PHOTOS = ['digital-laptop', 'digital-phone', 'daily-desklamp'].map((slug) =>
  productImage(slug, 0),
)

export default function Sell() {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [price, setPrice] = useState('')
  const [condition, setCondition] = useState<(typeof CONDITIONS)[number]['key']>('LIKE_NEW')
  const [free, setFree] = useState(false)
  const [photos, setPhotos] = useState<string[]>(DEMO_PHOTOS)

  const submit = () => {
    if (title.trim().length < 2) {
      void Taro.showToast({ title: '标题至少 2 个字', icon: 'none' })
      return
    }
    if (!free && !/^\d+(\.\d{1,2})?$/.test(price.trim())) {
      void Taro.showToast({ title: '请填写正确价格', icon: 'none' })
      return
    }
    if (description.trim().length < 1) {
      void Taro.showToast({ title: '请填写描述', icon: 'none' })
      return
    }
    void Taro.showToast({ title: '发布流程待接入', icon: 'none' })
  }

  const pickImage = () => {
    void Taro.showToast({ title: '图片上传待接入', icon: 'none' })
  }

  return (
    <View className="sell">
      <View className="sell__hero-bg" />
      <NavBar back={false} />

      <View className="sell__body">
        <View className="sell__head">
          <Text className="sell__title">
            出<Text className="sell__title-accent">物</Text>
          </Text>
          <Text className="sell__sub">拍几张照片，写清楚成色，同校自提更快成交</Text>
        </View>

        <View className="sell__card">
          <View className="sell__photos">
            {photos.map((src) => (
              <View key={src} className="sell__photo">
                <Image className="sell__photo-img" src={src} mode="aspectFill" />
                <View
                  className="sell__photo-del"
                  onClick={() => setPhotos((prev) => prev.filter((item) => item !== src))}
                >
                  <Image className="sell__photo-del-img" src={ICONS.delete} mode="aspectFit" />
                </View>
              </View>
            ))}
            {photos.length < 9 ? (
              <View className="sell__photo sell__photo--add" onClick={pickImage}>
                <Image className="sell__photo-add-img" src={ICONS.camera} mode="aspectFit" />
                <Text className="sell__photo-add-text">{`${photos.length}/9`}</Text>
              </View>
            ) : null}
          </View>

          <View className="sell__field">
            <Text className="sell__label">标题</Text>
            <Input
              className="sell__input"
              value={title}
              maxlength={40}
              placeholder="例如：罗技 K380 无线键盘 白色"
              onInput={(event) => setTitle(event.detail.value)}
            />
          </View>

          <View className="sell__field">
            <Text className="sell__label">描述</Text>
            <Input
              className="sell__input sell__input--area"
              value={description}
              maxlength={500}
              placeholder="买入时间、使用情况、有无磕碰、能否自提…"
              onInput={(event) => setDescription(event.detail.value)}
            />
          </View>

          <View className="sell__field">
            <Text className="sell__label">价格</Text>
            <View className="sell__price-row">
              <Text className="sell__price-cur">¥</Text>
              <Input
                className="sell__price-input"
                type="digit"
                value={free ? '0' : price}
                disabled={free}
                placeholder="0.00"
                onInput={(event) => setPrice(event.detail.value)}
              />
              <View
                className={`sell__toggle${free ? ' is-on' : ''}`}
                onClick={() => setFree((prev) => !prev)}
              >
                <Text className="sell__toggle-text">0 元送</Text>
              </View>
            </View>
          </View>

          <View className="sell__field">
            <Text className="sell__label">成色</Text>
            <View className="sell__chips">
              {CONDITIONS.map((item) => (
                <View
                  key={item.key}
                  className={`sell__chip${item.key === condition ? ' is-on' : ''}`}
                  onClick={() => setCondition(item.key)}
                >
                  <Text>{item.label}</Text>
                </View>
              ))}
            </View>
          </View>
        </View>

        <View className="sell__hint">
          <Text className="sell__hint-text">
            发布即表示你已阅读校内交易规范；违规商品会被下架（审核能力待接入）。
          </Text>
        </View>

        <View className="sell__submit" onClick={submit}>
          <Image className="sell__submit-icon" src={ICONS.plus} mode="aspectFit" />
          <Text className="sell__submit-text">发布闲置</Text>
        </View>
      </View>
    </View>
  )
}
