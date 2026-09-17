import { Image, Input, Text, View } from '@tarojs/components'
import Taro, { useLoad, useRouter } from '@tarojs/taro'
import { useMemo, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import EmptyState from '@/components/empty-state'
import ProductCard from '@/components/product-card'
import TopBar from '@/components/top-bar'
import { loadSearch } from '@/features/fetchers'
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
  const initialKeyword = (router.params.q ?? '').trim()

  /** 输入框里的文字（受控） */
  const [keyword, setKeyword] = useState(initialKeyword)
  /** 已提交的关键词；为空时显示建议面板（搜索历史 + 热门搜索） */
  const [submitted, setSubmitted] = useState(initialKeyword)
  const [results, setResults] = useState<MockListing[]>([])
  const [sort, setSort] = useState<SearchFilter>('综合')
  const [history, setHistory] = useState<string[]>(defaultSearchHistory)
  const [loading, setLoading] = useState(false)
  const [panelOpen, setPanelOpen] = useState(initialKeyword.length === 0)

  const hot = useMemo(() => hotSearches(), [])

  const run = async (nextKeyword: string, nextSort: SearchFilter) => {
    const term = nextKeyword.trim()
    if (!term) {
      setSubmitted('')
      setPanelOpen(true)
      setResults([])
      return
    }
    setLoading(true)
    // 「真实接口优先、失败退 mock」由 fetchers 统一负责，页面不自己 try/catch
    const list = await loadSearch(term, nextSort)
    setResults(list)
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

  /** 清空输入：回到建议面板 */
  const clearInput = () => {
    setKeyword('')
    setSubmitted('')
    setPanelOpen(true)
    setResults([])
  }

  const changeSort = (next: SearchFilter) => {
    setSort(next)
    if (submitted) void run(submitted, next)
  }

  useLoad(() => {
    if (initialKeyword) void run(initialKeyword, '综合')
  })

  const [left, right] = useMemo(() => splitColumns(results), [results])

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

          {/* 结果计数不能早于结果本身：否则请求途中会先显示「为你找到 0 件」 */}
          {loading ? null : (
            <View className="search__meta">
              <Text>为你找到</Text>
              <Text className="search__meta-num num">{results.length}</Text>
              <Text>{`件「${submitted}」相关闲置`}</Text>
            </View>
          )}

          {!loading && results.length === 0 ? (
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
