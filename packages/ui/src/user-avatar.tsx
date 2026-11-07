import defaultAvatarSrc from '@fish/ui/assets/avatar-default.png'
import { Avatar, AvatarFallback, AvatarImage } from './avatar'

/**
 * FISH 用户头像：组合 shadcn/ui 的 Avatar / AvatarImage / AvatarFallback。
 *
 * 为什么不是直接用 Avatar：本仓库当前基本没有真实头像图（契约里 `avatarUrl` 多为 `null`），
 * 无图时统一用 Owner 指定的插画 `assets/avatar-default.png` 顶替（#618），
 * 不再拿昵称首字母 / emoji 拼兜底——那种兜底既不可爱也泄露昵称信息。
 *
 * 三个细节：
 * - 默认图走 `import` 由打包器处理，不写 public 路径常量：换端 / 换 base 时不用改代码。
 * - 用包内自引的 `@fish/ui/assets/avatar-default.png`，不要改回 `../assets/...` 相对路径：
 *   本仓的 vite（rolldown）不会为 project root 之外的模块解析图片相对导入，构建会直接
 *   `UNRESOLVED_IMPORT`；走 package.json `exports` 的裸标识符才会被当成资源处理。
 * - `AvatarFallback` 里放同一张插画：真实头像 URL 加载失败时，radix 会把 Fallback 换上，
 *   于是落到插画而不是空白块（Fallback 是兜底兜底，别让它空着）。
 */
export type UserAvatarProps = {
  /** 头像图地址，为空时用默认插画。 */
  avatarUrl?: string | null
  size?: 'sm' | 'default' | 'lg' | 'xl'
  /** 加在 Avatar 根节点上，用于覆盖尺寸或外边距。 */
  className?: string
}

export function UserAvatar({
  avatarUrl = null,
  size = 'default',
  className = '',
}: UserAvatarProps) {
  const src = avatarUrl?.trim() || defaultAvatarSrc
  return (
    <Avatar className={className} size={size}>
      <AvatarImage alt="" className="object-cover" src={src} />
      <AvatarFallback>
        <img alt="" className="size-full object-cover" src={defaultAvatarSrc} />
      </AvatarFallback>
    </Avatar>
  )
}
