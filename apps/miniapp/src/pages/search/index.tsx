import { Image, Input, Text, View } from '@tarojs/components'
import Taro, { useLoad, useRouter } from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import EmptyState from '@/components/empty-state'
import LoadError from '@/components/load-error'
import ProductCard from '@/components/product-card'
import TopBar from '@/components/top-bar'
import { loadSearch } from '@/features/fetchers'
import { findListingByNumber } from '@/features/listing/api'
import { isListingNumberQuery } from '@/features/listing/number'
import {
  beginSearchTask,
  invalidateSearchTasks,
  isSearchTaskCurrent,
} from '@/features/listing/search-task'
import { isApiError } from '@/lib/request'
import { routeParam } from '@/lib/route-param'
import {
  defaultSearchHistory,
  hotSearches,
  type MockListing,
  type SearchFilter,
  searchFilters,
  searchPlaceholder,
} from '@/mock/api'
import { findUser } from '@/mock/users'
import './index.scss'

/** 结果瀑布流列宽（设计值 = 2×pt）：750 - 左右各 40 - 列间距 24，再除以 2 */
const COLUMN_WIDTH = 337

/** 设计稿的错落比例 → 图片区高度 */
const RATIO_HEIGHT: Record<MockListing['ratio'], number> = {
  '1x1': COLUMN_WIDTH,
  '4x5': Math.round((COLUMN_WIDTH * 5) / 4),
  '5x6': Math.round((COLUMN_WIDTH * 6) / 5),
  '3x4': Math.round((COLUMN_WIDTH * 4) / 3),
  '4x3': Math.round((COLUMN_WIDTH * 3) / 4),
}

/** 搜索历史最多留 10 条，新的放最前 */
const HISTORY_LIMIT = 10

function splitColumns(items: MockListing[]): [MockListing[], MockListing[]] {
  const left: MockListing[] = []
  const right: MockListing[] = []
  items.forEach((item, index) => {
    if (index % 2 === 0) left.push(item)
    else right.push(item)
  })
  return [left, right]
}

export default function Search() {
  const router = useRouter<{ q?: string }>()
  /** `?q=` 由心愿页用 `encodeURIComponent` 拼来，读的时候要解一次（见 `lib/route-param`） */
  const initialKeyword = routeParam(router.params.q).trim()

  /** 输入框里的文字（受控） */
  const [keyword, setKeyword] = useState(initialKeyword)
  /** 已提交的关键词；为空时显示建议面板（搜索历史 + 热门搜索） */
  const [submitted, setSubmitted] = useState(initialKeyword)
  const [results, setResults] = useState<MockListing[]>([])
  const [sort, setSort] = useState<SearchFilter>('综合')
  const [history, setHistory] = useState<string[]>(defaultSearchHistory)
  const [loading, setLoading] = useState(false)
  const [panelOpen, setPanelOpen] = useState(initialKeyword.length === 0)
  /** 真实接口失败且没有回退 mock（生产口径）：显示错误态而不是「没找到」 */
  const [failed, setFailed] = useState(false)
  /**
   * 编号精确查询的结果：
   * - `none`   不是编号查询（走关键词路径）
   * - `miss`   404，这个编号不存在 → 说「没找到这个编号」
   * - `opened` 命中且已跳详情 → 返回本页时得说清楚「刚才打开了什么」，不能回落成「没有找到相关闲置」
   */
  const [numberState, setNumberState] = useState<'none' | 'miss' | 'opened'>('none')

  const hot = useMemo(() => hotSearches(), [])

  /**
   * 本页唯一的任务代次（PR #280 复查 P2-2）：编号精确查询与关键词搜索**共用**一把尺子。
   * 新搜索、清空输入、页面卸载都让它前进，迟到的响应据此自我作废（判据见
   * `@/features/listing/search-task`）。
   */
  const taskLog = useRef(0)

  /**
   * 12 位商品编号（#217）走精确查询，和关键词搜索是两条路：
   * 契约对 `/listings/by-number/:listingNo` 的命中是**唯一一件**，页面不做列表，直接进详情。
   *
   * 只有 404 才是「这个编号不存在」。429（限流，带 `retryAfterSeconds`）与 503（暂时不可用）
   * 都**不能**说成没找到 —— 用户会以为编号写错了，而实际上只是要等一下。
   *
   * `startedAt` 是发起本次查询时的代次：命中后要**打开详情页**，所以写状态、弹提示、导航
   * 三件事都必须先确认这次响应仍属于最新那次搜索 —— 否则 N1 在途时搜了 N2，N1 迟到成功会
   * 把用户不想要的 N1 商品推上来。
   */
  const runNumber = async (term: string, startedAt: number) => {
    setLoading(true)
    setNumberState('none')
    setFailed(false)
    setResults([])
    setSubmitted(term)
    setPanelOpen(false)
    try {
      const id = await findListingByNumber(term)
      if (!isSearchTaskCurrent(taskLog, startedAt)) return
      setLoading(false)
      if (id === null) {
        setNumberState('miss')
        return
      }
      setNumberState('opened')
      void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${encodeURIComponent(id)}` })
    } catch (error) {
      if (!isSearchTaskCurrent(taskLog, startedAt)) return
      setLoading(false)
      setFailed(true)
      if (isApiError(error) && error.status === 429) {
        const wait = error.retryAfterSeconds
        void Taro.showToast({
          title: wait === undefined ? '查询太频繁，请稍后再试' : `查询太频繁，请 ${wait} 秒后再试`,
          icon: 'none',
        })
      }
    }
  }

  const run = async (nextKeyword: string, nextSort: SearchFilter) => {
    // 开新任务：编号查询与关键词搜索共用这一个代次，旧的在途任务就此作废
    const startedAt = beginSearchTask(taskLog)
    const term = nextKeyword.trim()
    if (!term) {
      setSubmitted('')
      setPanelOpen(true)
      setResults([])
      setNumberState('none')
      setLoading(false)
      return
    }
    if (isListingNumberQuery(term)) {
      await runNumber(term, startedAt)
      return
    }
    setNumberState('none')
    setLoading(true)
    // 「真实接口优先、只有开发/预览才退 mock」由 fetchers 统一负责，页面不自己 try/catch
    const { items: list, failed: nextFailed } = await loadSearch(term, nextSort)
    if (!isSearchTaskCurrent(taskLog, startedAt)) return
    setResults(list)
    setFailed(nextFailed)
    setSubmitted(term)
    setPanelOpen(false)
    setLoading(false)
  }

  const remember = (term: string) => {
    setHistory((prev) => [term, ...prev.filter((item) => item !== term)].slice(0, HISTORY_LIMIT))
  }

  /** 点历史 / 热门词：填进输入框并直接搜索 */
  const pickTerm = (term: string) => {
    setKeyword(term)
    remember(term)
    void run(term, sort)
  }

  /** 键盘确认 / 点「搜索」按钮 */
  const submit = () => {
    const term = keyword.trim()
    if (!term) return
    remember(term)
    void run(term, sort)
  }

  /** 清空输入：回到建议面板，并作废在途任务（否则迟到的响应会把结果写回已清空的页面） */
  const clearInput = () => {
    invalidateSearchTasks(taskLog)
    setKeyword('')
    setSubmitted('')
    setPanelOpen(true)
    setResults([])
    setNumberState('none')
    setLoading(false)
  }

  const changeSort = (next: SearchFilter) => {
    setSort(next)
    if (submitted) void run(submitted, next)
  }

  useLoad(() => {
    if (initialKeyword) void run(initialKeyword, '综合')
  })

  /** 卸载：作废在途任务，免得离页后迟到的编号命中仍然 navigateTo 出详情页 */
  useEffect(() => {
    return () => invalidateSearchTasks(taskLog)
  }, [])

  const [left, right] = useMemo(() => splitColumns(results), [results])

  /** 已提交的是 12 位编号：排序筛选与「为你找到 N 件」都无意义（命中只有唯一一件） */
  const isNumber = isListingNumberQuery(submitted)

  return (
    <View className="search">
      {/*
        固定顶栏（glass 变体）：返回钮 + 输入框，标题与微信胶囊同行居中。
        原先本页自绘「状态栏占位 + sticky 搜索条」，高度 148px（74pt），
        而设计稿 `.sbar` 是 88px（44pt）—— 现在由 top-bar 统一按胶囊反推，天然对齐。
      */}
      <TopBar
        variant="glass"
        spacer
        back
        onBack={() => void Taro.navigateBack()}
        center={
          <View className="search__field">
            <Input
              className="search__input"
              value={keyword}
              type="text"
              placeholder={searchPlaceholder}
              placeholderClass="search__input-ph"
              confirmType="search"
              onInput={(event) => setKeyword(event.detail.value)}
              onConfirm={submit}
            />
            {keyword.length > 0 ? (
              <View className="search__clear" onClick={clearInput}>
                <Image className="search__clear-img" src={ICONS.closeInk} mode="aspectFit" />
              </View>
            ) : null}
            <View className="search__submit" onClick={submit}>
              <Text>搜索</Text>
            </View>
          </View>
        }
      />

      {panelOpen ? (
        <View className="search__panel">
          <View className="search__block">
            <View className="search__block-head">
              <Text className="search__block-title">搜索历史</Text>
              {history.length > 0 ? (
                <View className="search__ghost" onClick={() => setHistory([])}>
                  <Image className="search__ghost-img" src={ICONS.delete} mode="aspectFit" />
                </View>
              ) : null}
            </View>
            {history.length > 0 ? (
              <View className="search__chips">
                {history.map((term) => (
                  <View key={term} className="search__chip" onClick={() => pickTerm(term)}>
                    <Text>{term}</Text>
                  </View>
                ))}
              </View>
            ) : (
              <Text className="search__hist-empty">暂无搜索历史</Text>
            )}
          </View>

          <View className="search__block">
            <View className="search__block-head">
              <Text className="search__block-title">热门搜索</Text>
              <Text className="search__block-note">同校热度 · 今日</Text>
            </View>
            <View className="search__hot">
              {hot.map((item, index) => (
                <View key={item.term} className="search__hot-i" onClick={() => pickTerm(item.term)}>
                  <Text className={`search__rank${index === 0 ? ' is-top' : ''}`}>{index + 1}</Text>
                  <Text className="search__hot-t">{item.term}</Text>
                  <Text className="search__hot-c">{item.count}</Text>
                </View>
              ))}
            </View>
          </View>
        </View>
      ) : (
        <View className="search__results">
          {/* 编号精确查询没有「综合 / 价格 / 最新」这些排序口径，命中只有唯一一件 */}
          {isNumber ? null : (
            <View className="search__filters">
              {searchFilters.map((item) => (
                <View
                  key={item}
                  className={`search__fchip${item === sort ? ' is-on' : ''}`}
                  onClick={() => changeSort(item)}
                >
                  <Text>{item}</Text>
                  {item === '价格' ? (
                    <View className="search__sort">
                      <Image
                        className="search__sort-img"
                        src={ICONS.chevronUpMuted}
                        mode="aspectFit"
                      />
                      <Image
                        className="search__sort-img"
                        src={ICONS.chevronDownMuted}
                        mode="aspectFit"
                      />
                    </View>
                  ) : null}
                </View>
              ))}
            </View>
          )}

          {/* 结果计数不能早于结果本身：否则请求途中会先显示「为你找到 0 件」；
              失败时也不显示，免得把「没加载出来」说成「一件都没有」 */}
          {loading || failed || isNumber ? null : (
            <View className="search__meta">
              <Text>为你找到</Text>
              <Text className="search__meta-num num">{results.length}</Text>
              <Text>{`件「${submitted}」相关闲置`}</Text>
            </View>
          )}

          {failed ? (
            <LoadError onRetry={() => void run(submitted, sort)} />
          ) : numberState === 'miss' ? (
            <EmptyState
              title="没有找到这个编号的商品"
              text="编号是 12 位数字。确认没输错的话，这件商品可能已经下架了。"
              actionText="按关键词搜索"
              onAction={() => clearInput()}
            />
          ) : numberState === 'opened' ? (
            <EmptyState
              title="已打开这件商品"
              text={`编号 ${submitted} 对应的商品刚才已经打开，可以再打开一次。`}
              actionText="再打开一次"
              onAction={() => void run(submitted, sort)}
            />
          ) : !loading && results.length === 0 ? (
            <EmptyState
              title="没有找到相关闲置"
              text="换个关键词试试，或者到许愿墙发一条心愿，让同校的人来接单。"
              actionText="去许愿墙发心愿"
              onAction={() => void Taro.switchTab({ url: '/pages/wish/index' })}
            />
          ) : (
            <View className="waterfall">
              <View className="waterfall__col">
                {left.map((item) => (
                  <ProductCard
                    key={item.id}
                    listing={item}
                    seller={findUser(item.sellerId)}
                    variant="search"
                    imageHeight={RATIO_HEIGHT[item.ratio]}
                  />
                ))}
              </View>
              <View className="waterfall__col">
                {right.map((item) => (
                  <ProductCard
                    key={item.id}
                    listing={item}
                    seller={findUser(item.sellerId)}
                    variant="search"
                    imageHeight={RATIO_HEIGHT[item.ratio]}
                  />
                ))}
              </View>
            </View>
          )}
        </View>
      )}
    </View>
  )
}
