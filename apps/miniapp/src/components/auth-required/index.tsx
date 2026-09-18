/**
 * 未登录 / 登录态未就绪时的页面占位。
 *
 * 为什么需要它：**守卫只负责跳转，跳转是异步的**。受限页的数据源（`@/mock/api`）
 * 是同步可得的，光靠守卫的话，跳转落地前页面已经画了一帧演示账号的数据 ——
 * 未登录用户会瞥见别人的昵称、计数、会话。所以受限页在拿到 `authed` 之前
 * 必须连渲染一起拦住，这个组件就是那一帧。
 *
 * 不写成 toast / 弹窗：它会短暂停留，做成安静的一行文案，避免和紧随其后的登录页叠在一起。
 */
import { Text, View } from '@tarojs/components'
import './index.scss'

type Props = {
  /** 冷启动还没问过后端时用「正在恢复」，避免对已登录用户误报「未登录」 */
  restoring?: boolean
}

export default function AuthRequired({ restoring = false }: Props) {
  return (
    <View className="authreq">
      <Text className="authreq-title">{restoring ? '正在恢复登录状态…' : '需要登录'}</Text>
      <Text className="authreq-text">
        {restoring ? '稍等一下，马上就好' : '登录后就能看到这里的内容'}
      </Text>
    </View>
  )
}
