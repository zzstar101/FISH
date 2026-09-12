import { useMemo } from 'react'
import { GradientWaves } from '../../components/gradient-waves'
import { tokenWhiteMix } from '../../lib/theme'

/**
 * 认证页（登录 / 注册）的全屏波浪背景。
 *
 * 颜色只从 `styles.css` 的设计令牌读取，再统一按 40% 白色混合（见 `lib/theme.ts`），
 * 这样波浪始终足够浅，深色正文与磨砂玻璃卡片的对比度不会被拉低。
 *
 * 取景参数相对组件示例做过调整：示例的 `tilt=1.11` 约等于把相机侧转 63°，
 * 光线要走约 55 单位才碰到波面，远超 `fogDepth=15`，alpha 只剩 0.2 左右，
 * 整屏退化成一层几乎看不见的雾。竖屏视口下改成小 `tilt` + 大 `fogDepth`，
 * 让波面落进可见范围；`opacity` 留有余量，避免背景压过 `text-ink-3` 的次要文字。
 */
export function AuthBackground() {
  const colors = useMemo(
    () => ({
      crestColor: tokenWhiteMix('--color-lavender', '#4f46e5'),
      horizonColor: tokenWhiteMix('--color-brand-soft', '#e9e8ff'),
      waveColor: tokenWhiteMix('--color-brand', '#0005ff'),
    }),
    [],
  )

  return (
    <div aria-hidden="true" className="absolute inset-0 -z-10">
      <GradientWaves
        {...colors}
        amplitude={2.5}
        brightness={1.05}
        detail="low"
        fogDepth={30}
        grain
        grainIntensity={0.025}
        height={5.5}
        opacity={0.65}
        parallaxStrength={0.5}
        speed={0.4}
        swell={35}
        tilt={0.35}
        turbulence={20}
        waveRatio={0.9}
        waveScale={0.9}
        zoom={1}
      />
    </div>
  )
}
