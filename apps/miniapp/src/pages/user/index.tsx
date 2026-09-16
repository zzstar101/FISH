import { Image, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useLoad, useRouter } from '@tarojs/taro'
import { useMemo, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import NavBar from '@/components/nav-bar'
import {
  fetchUserListings,
  fetchUserProfile,
  formatAmount,
  type MockListing,
  type MockUserProfile,
} from '@/mock/api'
import './index.scss'

/**
 * C2 他人主页（设计稿 `设计稿_C2-user.html`）。
 *
 * **隐私硬规则**（设计稿第 04 帧的「公开信息边界」）：公开页只展示
 * 头像 / 昵称 / 认证徽章 / 校区 / 在售数 / 卖出数 / 好评率；
 * **不展示**邮箱、学号、班级、真实姓名。未认证时不占位、不留白（徽章整块不渲染）。
 *
 * **与后端的边界**：契约没有公开用户资料端点，且 `GET /listings?sellerId=`
 * 仅限本人（传他人 403），所以连「TA 的在售」也拉不到 —— 整页 mock，
 * 标 `BLOCKED: 需新 Issue（公开用户资料）`。
 */

export default function UserHome() {
  const router = useRouter<{ id?: string }>()
  const userId = router.params.id ?? 'u-lin'

  const [profile, setProfile] = useState<MockUserProfile | null>(null)
  const [items, setItems] = useState<MockListing[]>([])
  const [loading, setLoading] = useState(true)
  /** 关注按钮三态：未关注 / 已关注 / 提交中 */
  const [following, setFollowing] = useState(false)
  const [followBusy, setFollowBusy] = useState(false)
  /** 已建会话后再点「聊一聊」换成「去会话」 */
  const [chatted, setChatted] = useState(false)

  useLoad(() => {
    void (async () => {
      const [p, list] = await Promise.all([fetchUserProfile(userId), fetchUserListings(userId)])
      setProfile(p)
      setFollowing(p.following)
      setItems(list)
      setLoading(false)
    })()
  })

  const [left, right] = useMemo(() => {
    const l: MockListing[] = []
    const r: MockListing[] = []
    items.forEach((item, i) => {
      if (i % 2 === 0) l.push(item)
      else r.push(item)
    })
    return [l, r]
  }, [items])

  const toggleFollow = () => {
    if (followBusy) return
    setFollowBusy(true)
    setTimeout(() => {
      setFollowBusy(false)
      setFollowing((prev) => !prev)
      void Taro.showToast({ title: following ? '已取消关注' : '已关注', icon: 'none' })
    }, 600)
  }

  const chat = () => {
    if (chatted) {
      void Taro.switchTab({ url: '/pages/chat/index' })
      return
    }
    setChatted(true)
    void Taro.showToast({ title: '发起会话待接入', icon: 'none' })
  }

  const card = (item: MockListing) => (
    <View
      key={item.id}
      className="uhome__card"
      onClick={() => void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${item.id}` })}
    >
      <View className="uhome__img">
        <Image className="uhome__img-real" src={item.coverUrl} mode="aspectFill" />
        {item.free ? (
          <Text className="uhome__corner uhome__corner--free">0 元送</Text>
        ) : item.urgent ? (
          <Text className="uhome__corner uhome__corner--hot">急出</Text>
        ) : null}
      </View>
      <View className="uhome__pbody">
        <Text className="uhome__ptitle">{item.title}</Text>
        <View className="uhome__pmeta">
          <Text className="uhome__pprice num">¥{formatAmount(item.priceCents)}</Text>
          {item.originalPriceCents ? (
            <Text className="uhome__porig num">¥{formatAmount(item.originalPriceCents)}</Text>
          ) : null}
        </View>
        <View className="uhome__pfoot">
          <Text className="uhome__pwant num">想要 {item.wants}</Text>
          <View className="uhome__dot" />
          <Text className="uhome__ptime">{`${Math.floor(item.createdHoursAgo / 24)} 天前`}</Text>
        </View>
      </View>
    </View>
  )

  const verified = profile?.user.authStatus === 'VERIFIED'

  return (
    <View className="uhome">
      <View className="uhome__hero-bg" />

      <NavBar
        actions={
          <View
            className="uhome__more"
            onClick={() =>
              void Taro.showActionSheet({
                itemList: ['举报该用户', '分享 TA 的主页'],
              }).catch(() => undefined)
            }
          >
            <Image className="uhome__more-ic" src={ICONS.moreInk} mode="aspectFit" />
          </View>
        }
      />

      {!profile ? null : (
        <>
          <View className="uhome__head">
            <View className="uhome__profile">
              <View className="uhome__avatar">
                <Text className="uhome__avatar-tx">{profile.user.nickname.slice(0, 1)}</Text>
              </View>
              <View className="uhome__pinfo">
                <View className="uhome__nameRow">
                  <Text className="uhome__pname">{profile.user.nickname}</Text>
                  {/* 徽章只在 VERIFIED 时渲染：未认证不占位、不留白 */}
                  {verified ? (
                    <View className="uhome__badge">
                      <Image
                        className="uhome__badge-ic"
                        src={ICONS.verifiedAccent}
                        mode="aspectFit"
                      />
                      <Text>已认证</Text>
                    </View>
                  ) : null}
                </View>
                <Text className="uhome__pcampus">
                  {profile.hiddenCampus
                    ? `未公开校区 · 加入 ${profile.joinedDays} 天`
                    : `${profile.user.campus}校区 · 加入 ${profile.joinedDays} 天`}
                </Text>
              </View>
            </View>

            <View className="uhome__stats">
              <View className="uhome__stat">
                <Text className="uhome__stat-num num">{profile.activeCount}</Text>
                <Text className="uhome__stat-label">在售</Text>
              </View>
              <View className="uhome__stat">
                <Text className="uhome__stat-num num">{profile.listedCount}</Text>
                <Text className="uhome__stat-label">卖出</Text>
              </View>
              <View className="uhome__stat">
                <Text className="uhome__stat-num num">
                  {verified ? `${profile.goodRate}%` : '--'}
                </Text>
                <Text className="uhome__stat-label">好评率</Text>
              </View>
            </View>
          </View>

          <View className="uhome__body">
            <View className="uhome__sect">
              <Text className="uhome__sect-title">TA 的在售</Text>
              <Text className="uhome__sect-cnt num">{`${items.length} 件`}</Text>
            </View>

            {loading ? (
              <View className="uhome__grid">
                {[0, 1, 2, 3].map((i) => (
                  <View key={`sk-${i}`} className="uhome__skel">
                    <View className="uhome__skel-img" />
                    <View className="uhome__skel-lines">
                      <View className="uhome__skel-bar" />
                      <View className="uhome__skel-bar" style={{ width: '56%' }} />
                    </View>
                  </View>
                ))}
              </View>
            ) : items.length === 0 ? (
              <View className="uhome__empty">
                <View className="uhome__empty-disc">
                  <Image className="uhome__empty-ic" src={ICONS.box} mode="aspectFit" />
                </View>
                <Text className="uhome__empty-title">TA 暂无在售商品</Text>
                <Text className="uhome__empty-text">TA 的东西都被抢光啦，有新上架会出现在这里</Text>
              </View>
            ) : (
              <ScrollView className="uhome__scroll" scrollY>
                <View className="uhome__grid">
                  <View className="uhome__col">{left.map(card)}</View>
                  <View className="uhome__col">{right.map(card)}</View>
                </View>
              </ScrollView>
            )}
          </View>

          {/* ---- 吸底动作条：关注（次）+ 聊一聊（主） ---- */}
          <View className="uhome__bar">
            <View
              className={`uhome__follow${following ? ' is-on' : ''}${followBusy ? ' is-busy' : ''}`}
              onClick={toggleFollow}
            >
              <Text>{followBusy ? '提交中…' : following ? '已关注' : '关注'}</Text>
            </View>
            <View className="uhome__chat" onClick={chat}>
              <Image className="uhome__chat-ic" src={ICONS.chatWhite} mode="aspectFit" />
              <Text>{chatted ? '去会话' : '聊一聊'}</Text>
            </View>
          </View>
        </>
      )}
    </View>
  )
}
