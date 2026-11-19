import type { ListingCategory } from '@/mock/types'
import apparel from './home-apparel.png'
import beauty from './home-beauty.png'
import books from './home-books.png'
import daily from './home-daily.png'
import digital from './home-digital.png'
import other from './home-other.png'
import recommend from './home-recommend.png'
import sports from './home-sports.png'
import transport from './home-transport.png'

export const HOME_PAGE_ICONS = {
  ALL: recommend,
  BOOKS: books,
  DIGITAL: digital,
  TRANSPORT: transport,
  DAILY: daily,
  SPORTS: sports,
  APPAREL: apparel,
  BEAUTY: beauty,
  OTHER: other,
} satisfies Record<ListingCategory | 'ALL', string>
