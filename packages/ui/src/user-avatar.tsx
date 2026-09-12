import { Avatar, AvatarFallback, AvatarImage } from './avatar'
import { cn } from './lib/utils'
import { TONE_CLASS, type Tone } from './thumb'

/**
 * FISH 用户头像：组合 shadcn/ui 的 Avatar / AvatarImage / AvatarFallback。
 *
 * 为什么不是直接用 Avatar：本仓库当前没有真实头像图（契约里 `avatarUrl` 为 `null`），
 * 一律用「柔和渐变底 + emoji」渲染。所以这里把 Fallback 的配色固化下来，
 * 页面只传 emoji 与 tone；将来接真实头像时传 `avatarUrl` 即可自动切到 AvatarImage。
 *
 * 替代原自研 `@fish/ui/avatar` 的 `Avatar`。
 */
export type UserAvatarProps = {
  /** 头像图地址，为空时回落到 emoji。 */
  avatarUrl?: string | null
  emoji: string
  tone?: Tone
  size?: 'sm' | 'default' | 'lg' | 'xl'
  /** 加在 Avatar 根节点上，用于覆盖尺寸或外边距。 */
  className?: string
  /** 加在 Fallback 上，用于覆盖 emoji 字号。 */
  fallbackClassName?: string
}

export function UserAvatar({
  avatarUrl = null,
  emoji,
  tone = 'violet',
  size = 'default',
  className = '',
  fallbackClassName = '',
}: UserAvatarProps) {
  return (
    <Avatar className={className} size={size}>
      {avatarUrl === null ? null : <AvatarImage alt="" src={avatarUrl} />}
      <AvatarFallback className={cn(TONE_CLASS[tone], fallbackClassName)}>{emoji}</AvatarFallback>
    </Avatar>
  )
}
