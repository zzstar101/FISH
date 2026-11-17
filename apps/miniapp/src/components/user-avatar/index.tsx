/**
 * 统一用户头像（#618）：**有图渲真实头像，无图渲同一张默认头像插画**。
 *
 * 为什么要有这个组件：仓库里 `avatarUrl` 大多为空（新注册用户更是如此），此前各页面各画各的
 * ——有的画人形图标、有的拿昵称首字顶替、有的塞 1×1 透明占位块，同一个人在不同页面长得不一样。
 * 兜底只允许有一种：`src/assets/avatar/default@3x.png`（Owner 指定的插画，见 #618；
 * 经 `@/assets/avatar` barrel 取用，不直接 import png）。
 *
 * **组件只管「里面那张图」**：容器尺寸 / 圆角 / 边框 / 背景 / 定位一律由调用点既有 class 决定，
 * 通过 `className` 挂到根节点上（组件不写死宽高，图片是 `100% × 100%`，圆角继承容器）。
 * 这样切头像不会改版式，新增调用点也不必在这里登记尺寸档位。
 *
 * 样式在同目录 `index.scss`，但由 `src/app.scss` **全局** `@use` 一次，组件内不 `import`：
 * 它被十几个页面/组件共用，逐处 `import` 会让同一份 CSS 在各 chunk 里按不同顺序插入，
 * `mini-css-extract-plugin` 就会报 "Conflicting order"（CI 里的 miniapp 构建日志会变脏）。
 */
import { Image, View } from '@tarojs/components'
import { useState } from 'react'
import { DEFAULT_AVATAR } from '@/assets/avatar'

type UserAvatarProps = {
  /** 真实头像地址；空串 / null / undefined 一律回落到默认头像 */
  src?: string | null
  /** 容器类名：尺寸 / 圆角 / 边框 / 定位沿用调用点既有 class */
  className?: string
  /** 头像本身就是点击区（进 TA 主页、换头像）时直接透传到容器 */
  onClick?: () => void
  /**
   * 懒加载（#595）：只在长列表里的头像（首页商品卡的卖家头像）开启，进入视口附近才发请求。
   * 不传 = 维持原行为（立即加载），其它调用点不受影响。尺寸 / 占位 / 失败回退都不变。
   */
  lazyLoad?: boolean
}

export default function UserAvatar({ src, className = '', onClick, lazyLoad }: UserAvatarProps) {
  // 图挂了（外链 404 / 签名过期）也回落默认头像：头像位永远是「一张图」，不留空圈。
  // 记的是「哪张 src 失败过」而不是一个 boolean，这样父级换了新地址能自动重试。
  const [failedSrc, setFailedSrc] = useState('')
  const url = typeof src === 'string' ? src.trim() : ''
  const showReal = url !== '' && url !== failedSrc

  return (
    <View className={className === '' ? 'user-av' : `user-av ${className}`} onClick={onClick}>
      {showReal ? (
        <Image
          className="user-av__img"
          src={url}
          mode="aspectFill"
          lazyLoad={lazyLoad}
          onError={() => setFailedSrc(url)}
        />
      ) : (
        <Image className="user-av__img" src={DEFAULT_AVATAR} mode="aspectFill" />
      )}
    </View>
  )
}
