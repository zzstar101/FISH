/**
 * 《第三方信息共享清单》 v2.0（唯一真源）。
 *
 * 按实际生产部署与代码调用链路逐项列明：
 * 第三方名称、共享或委托处理的信息、使用目的、传输/接入方式、对方官方隐私政策链接。
 *
 * 隐私政策链接均经实测确认可正常访问且对应各主体官方政策：
 * - 微信：https://weixin.qq.com/cgi-bin/readtemplate?lang=zh_CN&t=weixin_agreement&s=privacy
 * - 腾讯云：https://cloud.tencent.com/document/product/301/11470
 * - 飞书：https://www.feishu.cn/privacy
 * - 阿里云：https://terms.alicdn.com/legal-agreement/terms/suit_bu1_ali_cloud/suit_bu1_ali_cloud201902141711_54837.html
 * - 大模型服务商（DeepSeek 模型）：按 Owner 决策只披露类别与模型名称，不写具体公司名称与专属链接。
 */
import type { LegalDoc } from './types'

export const THIRD_PARTY_SHARING_DOC: LegalDoc = {
  navTitle: '第三方信息共享清单',
  kicker: {
    icon: 'share',
    text: 'Privacy · 第三方清单',
  },
  title: '鱼小应第三方信息共享清单',
  meta: [[{ t: '版本 v2.0' }], [{ t: '更新日期 2026-11-01' }], [{ t: '生效日期 2026-11-01' }]],
  brief: {
    head: '总体原则说明',
    lead: [
      {
        t: '「鱼小应」未嵌入任何第三方商业广告 SDK、跨应用追踪 SDK 或第三方统计分析 SDK。',
        b: true,
      },
      {
        t: '为支撑微信生态登录、云基础设施存储、内容安全合规检测、校园邮箱发信及 AI 智能检索，我们仅在最小必要范围内与下列服务提供方进行服务端接口交互或受托处理。',
      },
    ],
    items: [
      [
        { t: '绝不出售个人信息', b: true },
        { t: '，亦不会将你的实拍图片或聊天内容提供给第三方作营销画像。' },
      ],
      [
        { t: '受托处理数据均通过 ' },
        { t: 'HTTPS / TLS 加密服务端接口或加密 SMTP', b: true },
        { t: ' 传输，遵循最小化字段裁剪与脱敏原则。' },
      ],
      [
        { t: '如未来涉及向中华人民共和国境外提供个人信息，我们将依法履行前置程序并' },
        { t: '另行告知及取得你的单独同意', b: true },
        { t: '。' },
      ],
    ],
  },
  sections: [
    {
      id: 's1',
      num: '一',
      title: '微信开放能力合作方',
      blocks: [
        {
          key: 's1-b0',
          kind: 'list',
          head: {
            icon: 'user',
            text: '微信（深圳市腾讯计算机系统有限公司）',
          },
          items: [
            {
              key: 's1-b0-i0',
              name: [{ t: '小程序微信登录与 PC 站扫码登录' }],
              tag: { text: '平台接口交互', tone: 'on' },
              use: [
                { t: '第三方名称：', b: true },
                { t: '深圳市腾讯计算机系统有限公司（微信开放平台 / 微信小程序平台）\n' },
                { t: '涉及信息：', b: true },
                {
                  t: '小程序登录临时凭证（wx.login code）、应用内唯一标识 OpenID 及开放平台 UnionID\n',
                },
                { t: '使用目的：', b: true },
                { t: '识别微信用户身份以创建或登录鱼小应账号，支持 PC 站扫小程序码快捷登录\n' },
                { t: '接入方式：', b: true },
                { t: '微信小程序原生接口 + 服务端 HTTPS API（jscode2session 等）\n' },
                { t: '隐私政策：', b: true },
                {
                  t: 'https://weixin.qq.com/cgi-bin/readtemplate?lang=zh_CN&t=weixin_agreement&s=privacy',
                  em: true,
                },
              ],
            },
            {
              key: 's1-b0-i1',
              name: [{ t: '微信手机号快速验证与头像昵称填写组件' }],
              tag: { text: '用户点击授权', tone: 'opt' },
              use: [
                { t: '第三方名称：', b: true },
                { t: '深圳市腾讯计算机系统有限公司\n' },
                { t: '涉及信息：', b: true },
                {
                  t: '手机号一次性动态令牌（getPhoneNumber code）及换取的手机号；用户在组件内主动选择填入的微信头像与昵称\n',
                },
                { t: '使用目的：', b: true },
                { t: '按你的主动操作完成手机号安全绑定及个人资料便捷填写\n' },
                { t: '接入方式：', b: true },
                { t: '微信小程序官方开放组件 + 服务端 HTTPS API（phonenumber.getPhoneNumber）\n' },
                { t: '隐私政策：', b: true },
                {
                  t: 'https://weixin.qq.com/cgi-bin/readtemplate?lang=zh_CN&t=weixin_agreement&s=privacy',
                  em: true,
                },
              ],
            },
            {
              key: 's1-b0-i2',
              name: [{ t: '微信小程序一次性订阅消息推送' }],
              tag: { text: '用户允许后推送', tone: 'opt' },
              use: [
                { t: '第三方名称：', b: true },
                { t: '深圳市腾讯计算机系统有限公司\n' },
                { t: '涉及信息：', b: true },
                {
                  t: '接收方 OpenID、模板编号及通知摘要字段（对方昵称、商品名称、订单状态、审核结果、时间等，不含聊天消息正文和手机号）\n',
                },
                { t: '使用目的：', b: true },
                {
                  t: '在你点选「允许」订阅后，向你的微信服务通知下发消息未读提醒、订单状态更新或审核结果通知\n',
                },
                { t: '接入方式：', b: true },
                { t: '微信小程序 requestSubscribeMessage + 服务端 HTTPS API\n' },
                { t: '隐私政策：', b: true },
                {
                  t: 'https://weixin.qq.com/cgi-bin/readtemplate?lang=zh_CN&t=weixin_agreement&s=privacy',
                  em: true,
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 's2',
      num: '二',
      title: '云基础设施与内容安全受托处理方',
      blocks: [
        {
          key: 's2-b0',
          kind: 'list',
          head: {
            icon: 'safeAccent',
            text: '腾讯云（腾讯云计算（北京）有限责任公司）',
          },
          items: [
            {
              key: 's2-b0-i0',
              name: [{ t: '云服务器（CVM）与对象存储（COS）· 广州地域' }],
              tag: { text: '基础设施受托处理', tone: 'on' },
              use: [
                { t: '第三方名称：', b: true },
                { t: '腾讯云计算（北京）有限责任公司\n' },
                { t: '涉及信息：', b: true },
                {
                  t: '平台业务数据库数据，以及你上传的商品图片、个人头像、会话图片与语音、交易评价图片、交易争议附件图片与临时识图查询图片\n',
                },
                { t: '使用目的：', b: true },
                {
                  t: '在中国境内（广州地域）提供计算与持久化存储支持（非公开媒体均存放于私有前缀，凭短时效签名地址受控读取）\n',
                },
                { t: '接入方式：', b: true },
                { t: '云主机托管与服务端 S3/COS HTTPS 接口\n' },
                { t: '隐私政策：', b: true },
                { t: 'https://cloud.tencent.com/document/product/301/11470', em: true },
              ],
            },
            {
              key: 's2-b0-i1',
              name: [{ t: 'EdgeOne 内容分发网络（CDN）' }],
              tag: { text: '公开资源加速', tone: 'on' },
              use: [
                { t: '第三方名称：', b: true },
                { t: '腾讯云计算（北京）有限责任公司\n' },
                { t: '涉及信息：', b: true },
                {
                  t: '仅限已通过审核并公开上架的商品图片（listings/*）及客户端拉取公开图片时的网络请求连接信息\n',
                },
                { t: '使用目的：', b: true },
                {
                  t: '为公开展示的商品图片提供就近访问缓存加速（私聊媒体、评价图片、争议附件与识图查询图均不经过公开 CDN 缓存）\n',
                },
                { t: '接入方式：', b: true },
                { t: 'HTTPS 内容分发加速节点\n' },
                { t: '隐私政策：', b: true },
                { t: 'https://cloud.tencent.com/document/product/301/11470', em: true },
              ],
            },
            {
              key: 's2-b0-i2',
              name: [{ t: '文本内容安全（TMS）与图片内容安全（IMS）' }],
              tag: { text: '合规审核受托处理', tone: 'on' },
              use: [
                { t: '第三方名称：', b: true },
                { t: '腾讯云计算（北京）有限责任公司\n' },
                { t: '涉及信息：', b: true },
                {
                  t: '(1) 文本字段：创建或编辑闲置商品时的「商品标题（title）」与「商品描述（description）」；(2) 图片文件：上传确认时的「商品图片」与「用户头像图片」\n',
                },
                { t: '使用目的：', b: true },
                {
                  t: '识别违法违规、色情低俗、暴恐违禁及恶意导流图文，履行平台法定信息内容安全管理义务\n',
                },
                { t: '接入方式：', b: true },
                { t: '服务端 HTTPS API（腾讯云 TMS / IMS 接口）\n' },
                { t: '隐私政策：', b: true },
                { t: 'https://cloud.tencent.com/document/product/301/11470', em: true },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 's3',
      num: '三',
      title: '校园认证邮件与智能检索模型受托处理方',
      blocks: [
        {
          key: 's3-b0',
          kind: 'list',
          head: {
            icon: 'mail',
            text: '邮件发送服务商与人工智能模型服务商',
          },
          items: [
            {
              key: 's3-b0-i0',
              name: [{ t: '飞书（北京飞书科技有限公司）企业邮箱' }],
              tag: { text: '校园认证时触发', tone: 'opt' },
              use: [
                { t: '第三方名称：', b: true },
                { t: '北京飞书科技有限公司\n' },
                { t: '涉及信息：', b: true },
                {
                  t: '你主动填写的广应科教育邮箱地址（@gzasc.edu.cn）及 6 位一次性验证码邮件正文\n',
                },
                { t: '使用目的：', b: true },
                { t: '向你的校园邮箱投递身份认证验证码邮件\n' },
                { t: '接入方式：', b: true },
                { t: '服务端加密 SMTP（TLS）协议\n' },
                { t: '隐私政策：', b: true },
                { t: 'https://www.feishu.cn/privacy', em: true },
              ],
            },
            {
              key: 's3-b0-i1',
              name: [{ t: '阿里云（阿里云计算有限公司）百炼大模型服务' }],
              tag: { text: '向量化检索受托处理', tone: 'on' },
              use: [
                { t: '第三方名称：', b: true },
                { t: '阿里云计算有限公司\n' },
                { t: '涉及信息：', b: true },
                {
                  t: '(1) 文本向量化：在售商品的标题、描述与分类，以及求购心愿的需求关键词、描述与分类；(2) 多模态视觉向量化：在售商品首张封面图、拍照识图上传的查询图片及解析出的检索关键词（均剥离账号 ID、昵称、邮箱与手机号等身份标识）\n',
                },
                { t: '使用目的：', b: true },
                {
                  t: '计算高维语义向量与视觉特征向量，用于商品语义搜索、个性化推荐、求购心愿智能匹配及拍照找同款召回\n',
                },
                { t: '接入方式：', b: true },
                { t: '服务端 HTTPS API\n' },
                { t: '隐私政策：', b: true },
                {
                  t: 'https://terms.alicdn.com/legal-agreement/terms/suit_bu1_ali_cloud/suit_bu1_ali_cloud201902141711_54837.html',
                  em: true,
                },
              ],
            },
            {
              key: 's3-b0-i2',
              name: [{ t: '大模型服务商（DeepSeek 模型）' }],
              tag: { text: '主动触发时受托处理', tone: 'opt' },
              use: [
                { t: '第三方类别：', b: true },
                { t: '大模型服务商（DeepSeek 模型）\n' },
                { t: '涉及信息：', b: true },
                {
                  t: '(1) AI 润色场景：经服务端预先脱敏（自动剔除并替换身份证号、银行卡号、手机号、邮箱、微信号/QQ 号、楼栋宿舍号及网址）后的商品标题与描述草稿；(2) 拍照识图场景：你主动上传的查询图片（不含账号身份信息）\n',
                },
                { t: '使用目的：', b: true },
                {
                  t: '(1) 为你生成润色后的商品描述候选文案；(2) 对识图查询图片进行图像理解，解析物品类别、品牌型号与检索关键词以辅助检索站内相似商品\n',
                },
                { t: '接入方式：', b: true },
                {
                  t: '服务端 HTTPS API（如未来涉及向境外提供个人信息，将依法另行告知并取得你的单独同意）',
                },
              ],
            },
          ],
        },
        {
          key: 's3-b1',
          kind: 'notlist',
          head: {
            icon: 'checkAccent',
            text: '零第三方客户端 SDK 声明',
          },
          runs: [
            {
              t: '经核对本小程序客户端依赖包，除微信小程序基础运行框架外，我们未集成任何第三方广告联盟、行为埋点统计、消息推送或社交分享 SDK，不存在第三方 SDK 在你手机端直接静默采集设备识别码（IMEI/OAID/IDFA）或应用列表的情形。',
            },
          ],
        },
      ],
    },
  ],
  footNote: [
    [{ t: '鱼小应第三方信息共享清单 · 版本 v2.0' }],
    [{ t: '更新日期 2026-11-01 · 生效日期 2026-11-01' }],
  ],
  links: [
    {
      icon: 'safeAccent',
      label: '《隐私政策》',
      page: '/pkg-legal/pages/privacy/index',
    },
    {
      icon: 'category',
      label: '《个人信息收集清单》',
      page: '/pkg-legal/pages/info-collection/index',
    },
    {
      icon: 'docInk',
      label: '《用户协议》',
      page: '/pkg-legal/pages/terms/index',
    },
    {
      icon: 'shieldLine',
      label: '《社区规范与交易安全须知》',
      page: '/pkg-legal/pages/community-guidelines/index',
    },
  ],
  agree: {
    note: '点击即表示你已阅读并同意《用户协议》与《隐私政策》',
    ok: '同意并继续',
    no: '不同意',
  },
}
