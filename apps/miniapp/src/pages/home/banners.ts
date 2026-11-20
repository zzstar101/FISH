import dorm from '@/assets/page-illustrations/banner-dorm.jpg'
import exchange from '@/assets/page-illustrations/banner-exchange.jpg'
import textbooks from '@/assets/page-illustrations/banner-textbooks.jpg'

export const BANNERS = [
  { title: '校园闲置交换站', image: exchange },
  { title: '教材交换', image: textbooks },
  { title: '宿舍好物', image: dorm },
] as const

export function canAutoPlayBanner(pageVisible: boolean, inView: boolean, manual: boolean): boolean {
  return pageVisible && inView && !manual
}
