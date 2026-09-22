# FISH 生产部署手册（Ubuntu + Bun 直跑）

> 目标：把 `apps/web`、`apps/api`、`apps/worker` 直接跑在 Ubuntu 上，**不使用 Docker**。
> 依赖（PostgreSQL、MinIO）同样装成宿主服务。
>
> 本手册只描述部署，不改变任何业务/契约行为。生产形态与 [architecture.md](architecture.md) §4 的
> 本地拓扑**同构**，区别只是应用由 systemd 托管、前面多一个反向代理提供 HTTPS。

## 0. 拓扑与不变量

```text
                 Internet
                    │  80 / 443
              ┌─────▼──────┐
              │  Caddy     │  TLS + 静态产物 + 反代
              └──┬──┬───┬──┘
     fish.example.com      s3.fish.example.com
        │        │                │
        │        │ /api/* /ws*    │（原样透传，保留 Host）
        │        ▼                ▼
        │   ┌─────────┐     ┌──────────┐
        │   │ api     │     │ MinIO    │
        │   │ :3000   │     │ :9000    │
        │   └────┬────┘     └────┬─────┘
        │        │               │
        │   ┌────▼────┐          │
        │   │ worker  │          │
        │   └────┬────┘          │
        │        │               │
        └────────┴───────┬───────┘
                    ┌────▼────┐
                    │Postgres │
                    │ :5432   │
                    └─────────┘
```

必须一直成立的四条不变量（违反任何一条都会出数据问题，见 §9）：

1. **同一数据库同时只跑一个 worker 进程**。
2. **`/api` 前缀在反代层剥掉**，API 自身路由是根级的。
3. **`S3_ENDPOINT` / `S3_PUBLIC_URL` 必须是浏览器可达的地址**，且反代必须保留 `Host`。
4. **`WEB_ORIGIN` 必须是 `https://<域名>`**（决定会话 cookie 带不带 `Secure`）。

## 1. 前置条件

| 项 | 要求 | 依据 |
| --- | --- | --- |
| 系统 | Ubuntu 24.04 LTS（apt 里有 PostgreSQL 16）；22.04 需要加 PGDG 源 | [README.md](../README.md) 技术栈表要求 PostgreSQL 16 |
| PostgreSQL | 16、**17 或 18 均可**（迁移只用枚举/表/索引/ jsonb，无 `CREATE EXTENSION`）；注意 Ubuntu 26.04 的 apt 里只有 18 | 已在 PostgreSQL 18.6 / aarch64 上实测 `db:migrate` 通过 |
| Bun | `>= 1.4.0`（本手册钉 `1.4.0`） | 根 `package.json` 的 `engines.bun` / `packageManager` |
| Node.js | **不需要**。`drizzle-kit` 在本仓也是一直由 Bun 拉起 | `packages/db/package.json` 的 `migrate` 脚本 |
| 域名 | 两个 A 记录：主域名 + 对象存储子域（`s3.<域名>`） | §6 的 SigV4 约束 |
| 端口 | 只对外开放 80 / 443 | 下面 ufw 那一步（目标环境只给一个端口时见 §11） |

一次装好：

```bash
# rsync 是 §7 发布/回滚流程要用的（最小化镜像里没有）
sudo apt update && sudo apt install -y curl git unzip ca-certificates ufw rsync

# Bun 系统级安装（不要装进某个用户的 ~/.bun，systemd 的 service 用户读不到）。
# 注意安装脚本读的是 **bash 进程**的 BUN_INSTALL（`install_dir=${!install_env:-$HOME/.bun}`），
# 所以变量要写在 bash 那一侧，不能写在 curl 前面。
curl -fsSL https://bun.sh/install | sudo BUN_INSTALL=/usr/local bash -s "bun-v1.4.0"
/usr/local/bin/bun --version    # 期望 1.4.0

# 运行用户与代码目录
sudo useradd --system --create-home --shell /usr/sbin/nologin fish
sudo mkdir -p /srv/fish /var/www/fish /var/backups/fish
sudo chown fish:fish /srv/fish /var/backups/fish

# 防火墙：只放 80/443，3000 / 5432 / 9000 / 9001 一律不对外
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable
```

> ⚠️ API 由 `Bun.serve({ port })` 启动，**默认监听 `0.0.0.0:3000`**（`apps/api/src/index.ts`）。
> 代码里没有 `hostname` 选项，所以「只监听回环」这件事目前只能靠 ufw 保证。要让 API 本身只绑
> 127.0.0.1 需要改 `apps/api/src/index.ts`（Owner 独占，另开 Issue）。

## 2. PostgreSQL 16

```bash
sudo apt install -y postgresql-16 postgresql-client-16

# 业务库与账号（密码换成真实的，后面 .env 里要用同一份）
sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE fish LOGIN PASSWORD 'REPLACE_ME_DB_PASSWORD';
CREATE DATABASE fish OWNER fish;
SQL
```

Ubuntu 的默认配置 `listen_addresses = 'localhost'`、`password_encryption = scram-sha-256`，
即已满足「只允许本机 + 密码校验」，无需改动 `pg_hba.conf`。

**不需要 pgvector 扩展。** `packages/db/src/migrations/*.sql` 里没有任何 `CREATE EXTENSION`
（CI 与 `docker-compose.yml` 用 `pgvector/pgvector:pg16` 镜像只是与开发环境保持一致）。
将来若要装：`sudo apt install postgresql-16-pgvector`（可选）。

验证：

```bash
PGPASSWORD='REPLACE_ME_DB_PASSWORD' psql -h 127.0.0.1 -U fish -d fish -c 'select version()'
```

## 3. MinIO（对象存储）

> ⚠️ **MinIO 的开源版已于 2025 年归档，官方不再提供二进制。**
> `https://dl.min.io/server/minio/release/linux-*/minio` 与对应的 `mc` 现在一律返回
> **410 Gone**（全平台，不只是 arm64）。实测确认：从容器镜像里取二进制仍然可行——
> `quay.io/minio/minio:latest` 的多架构清单里仍有 `linux/arm64` 与 `linux/amd64`
> （正是本仓 CI 用的那个来源，`.github/workflows/ci.yml`）。
>
> 对课程/内部部署这仍然是最省事的路线（契约与 compose 都按 MinIO 写）；但要清楚：
> **归档版不会再有任何安全修复**。长期跑的部署应考虑换成仍在维护的 S3 实现（SeaweedFS /
> Garage / 云厂商对象存储），那需要同步验证 `presign` 直传与匿名读这两条链路。

也可以换成任何 S3 兼容服务（Cloudflare R2 / 阿里云 OSS）：换掉 `.env` 的 `S3_*` **六**项
（含 `S3_PUBLIC_URL`，它决定读接口拼出的图片直链）即可，其它步骤不变，并且可以跳过 §6 的
`s3.<域名>` 反代。

**不要用 `curl` 从 `dl.min.io` 下载**。从官方镜像里取二进制（`skopeo` 不需要 docker 守护进程）：

```bash
# 需要 skopeo（以及下方解压用的 tar）
sudo apt install -y skopeo

# 按目标机器架构覆盖：https://<宿主> 上是 amd64 就用 amd64
ARCH=arm64   # 或 amd64
for img in minio mc; do
  rm -rf /tmp/$img-img && skopeo copy --override-os linux --override-arch "$ARCH" \
    docker://quay.io/minio/$img:latest dir:/tmp/$img-img
  for layer in /tmp/$img-img/*; do
    tar -tzf "$layer" >/dev/null 2>&1 || continue
    tar -tzf "$layer" | grep -qE "usr/bin/$img\$" || continue
    sudo tar -xzf "$layer" -C /tmp --strip-components=2 "usr/bin/$img"
  done
  sudo install -m 755 /tmp/$img /usr/local/bin/$img
  rm -rf /tmp/$img-img /tmp/$img
  /usr/local/bin/$img --version | head -1
 done

sudo useradd --system --no-create-home --shell /usr/sbin/nologin minio-user
sudo mkdir -p /var/lib/minio && sudo chown minio-user:minio-user /var/lib/minio
```

（实测环境为 aarch64，取出的 `minio` 为 `RELEASE.2025-09-07T16-13-09Z`、
`Runtime: go1.24.6 linux/arm64`，可直接执行；`mc` 同理。）

`/etc/default/minio`（`chmod 600`，含口令）：

```bash
MINIO_ROOT_USER=fish
MINIO_ROOT_PASSWORD=REPLACE_ME_MINIO_PASSWORD
MINIO_VOLUMES=/var/lib/minio
# 只监听回环：外网访问一律经 §6 的 s3.<域名>
MINIO_OPTS="--address 127.0.0.1:9000 --console-address 127.0.0.1:9001"
```

`/etc/systemd/system/minio.service`：

```ini
[Unit]
Description=MinIO
After=network-online.target
Wants=network-online.target

[Service]
User=minio-user
Group=minio-user
EnvironmentFile=/etc/default/minio
ExecStart=/usr/local/bin/minio server $MINIO_VOLUMES $MINIO_OPTS
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

启动并建桶 + 仅公开商品图片（聊天媒体必须私有）：

```bash
sudo chmod 600 /etc/default/minio
sudo systemctl daemon-reload && sudo systemctl enable --now minio

# 桶名必须与 .env 的 S3_BUCKET 一致
export MC_HOST_local="http://fish:REPLACE_ME_MINIO_PASSWORD@127.0.0.1:9000"
mc mb --ignore-existing local/fish
# 从本仓库复制 infra/minio-public-policy.json 到 /etc/fish-public-policy.json。
# 若桶名不是 fish，先替换该 JSON 的 Resource 中的桶名。
mc anonymous set-json /etc/fish-public-policy.json local/fish

# 应用**不要**直接用 root 凭据：root 能建用户、删桶、改策略。给应用单开一个只作用于该桶的账号。
cat > /etc/minio-app-policy.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::fish/*"] },
    { "Effect": "Allow", "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": ["arn:aws:s3:::fish"] }
  ]
}
JSON
mc admin user add local fish-app REPLACE_ME_MINIO_APP_SECRET
mc admin policy create local fish-app-rw /etc/minio-app-policy.json
mc admin policy attach local fish-app-rw --user fish-app
```

（桶名出现在策略 JSON 的两处 `arn:aws:s3:::fish`，改 `S3_BUCKET` 时要一起改。）

升级已有部署也必须重新应用上述匿名策略，替换原整桶 download 策略。仅 `listings/*`
允许匿名 GetObject；`chat-media/*` 和 `chat-media-final/*` 不能匿名读或列举。
上线前执行 `MEETUP_TOKEN_SECRET=$(openssl rand -hex 32) bun --env-file=.env apps/api/scripts/media-smoke.ts`，
验证聊天直链返回 403、鉴权代理仍能读取及 Range 播放。那个变量是因为脚本会**自己拉起一个 API 进程**
（`apps/api/scripts/media-smoke.ts:52`），而 API 启动时会校验面交码密钥（§4）；这里给的是只活在这条
命令里的一次性值，**不要**写进 `.env`——生产的密钥归 §4 的 `/etc/fish/api-mail.env`。#141 起 API 还
强制要求 AI 润色配置，脚本会自己注入 stub 的两个变量（不会出网），不必再手工传。

## 4. 代码与环境变量

```bash
sudo -u fish git clone <仓库地址> /srv/fish
cd /srv/fish
sudo -u fish -H /usr/local/bin/bun install --frozen-lockfile
```

> **不要裁剪 devDependencies**（不要用 `--production`）：`bun run db:migrate` 走 `drizzle-kit`，
> 而 `drizzle-kit` 需要一个 Node 语义的 Postgres 驱动，即 `packages/db` 的 devDependency `postgres`。
> 这是刻意例外，见 [architecture.md](architecture.md)「一个已知的驱动例外」。

`/srv/fish/.env`（`chown fish:fish`、`chmod 600`，**绝不提交**）：

```bash
# 库：host 必须是 localhost / 127.0.0.1（同机部署）
DATABASE_URL=postgres://fish:REPLACE_ME_DB_PASSWORD@127.0.0.1:5432/fish

# API
API_PORT=3000
# ⚠️ 必须是 https 且与浏览器地址**逐字符一致**（无尾斜杠）。
# 它同时是 CORS 白名单与会话 cookie 的 Secure 开关：
# apps/api/src/app.ts 用 WEB_ORIGIN.startsWith('https://') 推导 secureCookie，
# 写成 http:// 会话 cookie 就不会带 Secure。
WEB_ORIGIN=https://fish.example.com

# 对象存储：这两个地址必须**服务端与浏览器都能访问**（原因见 §9 第 4 条）
S3_ENDPOINT=https://s3.fish.example.com
S3_REGION=us-east-1
# 用 §3 建的最小权限账号，不是 root
S3_ACCESS_KEY_ID=fish-app
S3_SECRET_ACCESS_KEY=REPLACE_ME_MINIO_APP_SECRET
S3_BUCKET=fish
S3_PUBLIC_URL=https://s3.fish.example.com/fish
```

`@fish/shared/env` 的 Zod schema 要求 api 与 worker **都**能拿到这 9 项（`WEB_ORIGIN`、
`S3_*` 即使 worker 用不到也必须存在；其中 8 项无默认值，`API_PORT` 有默认），
缺一项进程直接启动失败——这是刻意的 fail-fast。

下面这几项**只有 API 需要**（worker 只加载 `loadServerEnv`，见 `apps/worker/src/index.ts:2,9`），统一放
`/etc/fish/api-mail.env`（`root:root`、`chmod 600`，由 §5.1 的 `EnvironmentFile` 注入）。
文件名里的 `mail` 是历史遗留：自 #70 起它承载**全部** API 专属密钥。不要把它们写进
api/worker 共用的 `/srv/fish/.env`：那个文件在应用工作目录里，是 `git add`、镜像同步、
"随手 cat 给同事"最容易顺手带上的位置。
（这缩小的是**误提交 / 误扩散**面，不是权限边界：unit 是 `User=fish`，同 uid 的进程能从
`/proc/<pid>/environ` 读到注入后的值，所以应用代码被攻破时两种放法等价。此为 Linux 语义，
本机未实测。）

```bash
# 校园认证邮件（仅 API 加载）
MAIL_TRANSPORT=resend
RESEND_API_KEY=REPLACE_ME_RESEND_API_KEY
RESEND_FROM="鱼小应 <noreply@YOUR_VERIFIED_DOMAIN>"

# #70 面交码的 HMAC 签名密钥（仅 API 加载；必填且不少于 32 字符）
MEETUP_TOKEN_SECRET=REPLACE_ME_64_HEX

# #141 商品描述 AI 润色的上游（仅 API 加载；transport 必填，无默认值）
# 换服务商只改 BASE_URL 与 MODEL 两行；API_KEY 从服务商控制台取。
AI_POLISH_TRANSPORT=live
AI_POLISH_BASE_URL=https://api.deepseek.com
AI_POLISH_API_KEY=REPLACE_ME_UPSTREAM_KEY
AI_POLISH_MODEL=deepseek-flash
```

先在 Resend 验证发件域名（含 SPF/DKIM）。**只有首次部署**才用下面这段整份写入；两个密钥都从
`read` 进内存再落盘，不要直接粘在命令里——那会永久留在 root 的 shell 历史里。`RESEND_FROM`
也必须问进来：`loadMailTransportEnv` 只验它非空，占位域名会照样把服务起起来、直到发信时才失败。

```bash
sudo install -d -m 755 /etc/fish
read -r  -p '发件地址（已在 Resend 验证过的域名）: ' RESEND_FROM
read -rs -p 'Resend 密钥（不回显）: ' RESEND_API_KEY && echo
read -rs -p 'AI 润色上游密钥（不回显）: ' AI_POLISH_API_KEY && echo
{
  printf 'MAIL_TRANSPORT=resend\n'
  printf 'RESEND_API_KEY=%s\n' "$RESEND_API_KEY"
  printf 'RESEND_FROM="%s"\n' "$RESEND_FROM"
  printf 'MEETUP_TOKEN_SECRET=%s\n' "$(openssl rand -hex 32)"
  printf 'AI_POLISH_TRANSPORT=live\n'
  printf 'AI_POLISH_BASE_URL=https://api.deepseek.com\n'
  printf 'AI_POLISH_API_KEY=%s\n' "$AI_POLISH_API_KEY"
  printf 'AI_POLISH_MODEL=deepseek-flash\n'
} | sudo tee /etc/fish/api-mail.env >/dev/null
sudo chown root:root /etc/fish/api-mail.env && sudo chmod 600 /etc/fish/api-mail.env
unset RESEND_API_KEY RESEND_FROM AI_POLISH_API_KEY
```

**已经按旧版手册部署过的机器不要重跑上面那一段**：`tee` 是整文件覆写，会顺手换掉
`MEETUP_TOKEN_SECRET`，所有已签发未核销的面交码立刻失效（§9 第 12 条）。升级只需补那一行：

```bash
sudo grep -q '^MEETUP_TOKEN_SECRET=' /etc/fish/api-mail.env \
  || printf 'MEETUP_TOKEN_SECRET=%s\n' "$(openssl rand -hex 32)" | sudo tee -a /etc/fish/api-mail.env >/dev/null
```

**#141 起 API 还需要四个 AI 变量，且 `AI_POLISH_TRANSPORT` 无默认值**：升级后不补它，API 会**直接
启动失败**（`环境变量校验失败：AI_POLISH_TRANSPORT 必须显式设置为 stub 或 live`），配合
`Restart=always` 就是反复重启。老机器用下面这段追加（`tee -a` 不覆写已有行，不会动面交码密钥）：

```bash
read -rs -p 'AI 润色上游密钥（不回显）: ' AI_POLISH_API_KEY && echo
{
  printf 'AI_POLISH_TRANSPORT=live\n'
  printf 'AI_POLISH_BASE_URL=https://api.deepseek.com\n'
  printf 'AI_POLISH_API_KEY=%s\n' "$AI_POLISH_API_KEY"
  printf 'AI_POLISH_MODEL=deepseek-flash\n'
} | sudo tee -a /etc/fish/api-mail.env >/dev/null
unset AI_POLISH_API_KEY
```

暂时不开通这个功能也要写这四行（否则 API 起不来）：把 `AI_POLISH_TRANSPORT` 写成 `stub`、
`AI_POLISH_BASE_URL` 指向本地假服务（`apps/api/scripts/ai-polish-stub.ts`）即可，但**生产不要用
stub**——它返回的是演示文案，客户端会带"演示文案·非真实模型"角标。

- `AI_POLISH_TRANSPORT` 必填且无默认值，取值非法同样启动失败；选 `live` 时
  `AI_POLISH_BASE_URL` / `AI_POLISH_API_KEY` / `AI_POLISH_MODEL` 三项缺一即失败——与
  `MAIL_TRANSPORT` 同一 fail-fast 口径，不静默回退。选 `stub` 也要求 `AI_POLISH_BASE_URL`
  （它是真 HTTP 服务，"stub" 指模型是假的，不是指进程内有个假实现）。
- 上游密钥轮换不影响存量数据——这与 `MEETUP_TOKEN_SECRET` 不同（换后者会让未核销的面交码立刻
  失效）。但它同样会随 §10 备份的 `config-*.tar.gz` 进备份，泄漏处置按同一口径。
- 本期**不设成本上限与告警**（设计 §11-R1）：用量落在 `ai_polish_requests`
  （`outcome` / `prompt_tokens` / `completion_tokens` / `latency_ms`），事后查表；配额是每用户
  最小间隔 5s + 滚动 24h 30 次正常调用，另有 `EMPTY` 出口的单列 60/日桶（设计 §5.2 / #173）
  ——每账号 24h 内的调用上界因此是 **89 次**（29 次非 `EMPTY` + 59 次 `EMPTY` + 1 次在飞占位）。

- 用 `openssl rand -hex 32`（64 个 `[0-9a-f]`）而不是 `base64`：systemd 的 `EnvironmentFile`
  不做 shell 展开，纯 hex 可以免掉 `$`、引号与 `#` 引发的整类解析歧义。
- **不要把 `.env.example` 里那行 `dev-only-meetup-secret-…` 抄到生产**。它在公开仓库里，
  照抄等于公开签名密钥，任何人可离线伪造任意面交码。
- `MAIL_TRANSPORT` 必填，选择 `resend` 但缺少密钥或发件人时 API 启动失败；`NODE_ENV` 不选择
  transport。`outbox` 仅供本地开发，不能投递真实邮件。若从 `.env.example` 复制了生产 `.env`，
  移除其中的 `MAIL_TRANSPORT=outbox` 与 `MEETUP_TOKEN_SECRET=dev-only-…`，避免与 API 专属配置并存。

## 5. systemd 托管

### 5.1 API

`/etc/systemd/system/fish-api.service`：

```ini
[Unit]
Description=FISH API (Hono on Bun)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=fish
Group=fish
WorkingDirectory=/srv/fish/apps/api
# 通用配置来自 .env；邮件与面交码密钥（§4）仅注入 API，不传给 worker。
EnvironmentFile=/etc/fish/api-mail.env
ExecStart=/usr/local/bin/bun --env-file=/srv/fish/.env /srv/fish/apps/api/src/index.ts
Restart=always
RestartSec=5
LimitNOFILE=65535
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

### 5.2 Worker

`/etc/systemd/system/fish-worker.service`：

```ini
[Unit]
Description=FISH Worker (job polling)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=fish
Group=fish
WorkingDirectory=/srv/fish/apps/worker
ExecStart=/usr/local/bin/bun --env-file=/srv/fish/.env /srv/fish/apps/worker/src/index.ts
Restart=always
RestartSec=5
LimitNOFILE=65535
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
# ⚠️ 本 unit 刻意不是模板 unit（没有 fish-worker@.service）：
#    同一数据库同时只能有一个 worker 进程，见 §9 第 1 条。
```

```bash
sudo systemctl daemon-reload
# 只 enable，不 --now：首次上线时库还没建表。worker 启动会立刻执行 recoverStaleClaims()
#（apps/worker/src/index.ts:27；具体的 `UPDATE jobs …` 在 apps/worker/src/jobs/queue.ts:170），
# 表不存在就直接抛错退出，然后每 5 秒重启一次。启动放在 §7.1 的迁移之后。
sudo systemctl enable fish-api fish-worker
```

## 6. 反向代理与 HTTPS

以 Caddy 为例（80/443 自动签发证书）。`sudo apt install -y caddy`，`/etc/caddy/Caddyfile`：

```caddyfile
fish.example.com {
	encode zstd gzip

	# 与 apps/web/vite.config.ts 的 /api 代理等价：剥掉 /api 前缀转发到 API 的根级路由。
	# 浏览器只写相对路径 /api/...（apps/web/src/lib/api-client.ts），生产是同源部署，
	# 因此不需要跨域，cookie 自动携带。
	handle /api/* {
		uri strip_prefix /api
		reverse_proxy 127.0.0.1:3000
	}

	# 业务实时通道 /ws/chat：**不做**前缀重写。
	# 只放 /ws/*，不放 `/ws`：那是开发用的 echo 冒烟入口，没有任何鉴权
	#（apps/api/src/app.ts 的 `app.get('/ws', upgradeWebSocket(...))` 只回显文本帧），
	# 不该出现在公网暴露面上；冒烟请在服务器本地打 API 端口（§8 第 3 步）。
	handle /ws/* {
		reverse_proxy 127.0.0.1:3000
	}

	# 带内容哈希的产物：长缓存
	handle /assets/* {
		root * /var/www/fish
		header Cache-Control "public, max-age=31536000, immutable"
		file_server
	}

	# SPA 兜底：TanStack Router 走 history 路由，深链接必须回落到 index.html；
	# index.html 不缓存，否则发版后客户端会一直拿着指向旧哈希产物的壳。
	handle {
		root * /var/www/fish
		header Cache-Control "no-store"
		try_files {path} /index.html
		file_server
	}
}

# 对象存储单独域名，仅透传。
# 必须原样保留 Host：预签名 URL 由 Bun.S3Client 按 S3_ENDPOINT 的 host 签名
#（apps/api/src/modules/uploads/storage.ts 的 presignPut），浏览器拿着它直传；
# Host 被改写成 127.0.0.1 会让 SigV4 校验失败（403）。
s3.fish.example.com {
	reverse_proxy 127.0.0.1:9000 {
		header_up Host {host}
	}
}
```

```bash
sudo systemctl reload caddy
```

<details>
<summary>用 nginx 时等价的两段配置</summary>

```nginx
# 主站
server {
  listen 443 ssl http2;
  server_name fish.example.com;
  root /var/www/fish;

  location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; }
  location /api/ {
    proxy_pass http://127.0.0.1:3000/;   # 末尾的 / 才会剥掉 /api 前缀
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }
  location /ws {                        # /ws 与 /ws/chat 都要能 upgrade
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 1h;              # 客户端心跳 25s 一次（apps/web/src/features/chat/realtime.ts）
  }
  location / {
    add_header Cache-Control "no-store";
    try_files $uri /index.html;
  }
}

# 对象存储：同样必须保留原始 Host
server {
  listen 443 ssl http2;
  server_name s3.fish.example.com;
  location / {
    proxy_pass http://127.0.0.1:9000;
    proxy_set_header Host $host;
    client_max_body_size 20m;
  }
}
```

证书用 `certbot --nginx`；`/etc/letsencrypt` 要纳入备份（续期失败会导致整站不可用）。
</details>

## 7. 迁移、构建、发布

### 7.1 首次上线

```bash
cd /srv/fish

# 1) 建表（走仓库文档化的同一条命令；它需要 §4 的 .env）
sudo -u fish -H /usr/local/bin/bun run db:migrate

# 2) 前端产物：构建到 apps/web/dist，再同步到 Caddy 的根目录
sudo -u fish -H /usr/local/bin/bun run build
sudo rsync -a --delete /srv/fish/apps/web/dist/ /var/www/fish/
sudo chown -R caddy:caddy /var/www/fish   # 换 nginx 时改成 www-data

# 3) 起服务（§5 里只 enable 了，这里才第一次启动）
sudo systemctl restart fish-api fish-worker
```

**不要在生产跑 `bun run db:seed`。** 它会 `TRUNCATE` 全部业务表，而它的守卫只检查连接串的
hostname（`packages/db/src/seed.ts:284-291`）——生产库正好是 `127.0.0.1`，守卫会**放行**。

### 7.2 日常发布

```bash
#!/usr/bin/env bash
# 建议存为 /usr/local/bin/fish-deploy，sudo 执行（chmod +x）
set -euo pipefail
cd /srv/fish

# 0) 预检 API 专属配置（§4）。脚本以 root 执行，所以直接读那个 600 的文件。
#    缺 MEETUP_TOKEN_SECRET（#70）或缺 AI 润色变量（#141）都会让 API 拒绝启动，
#    配合 Restart=always 就是每 5 秒一次的 crash loop —— 而那时第 3 步已经把服务
#    停了。放在最前面：预检不过就一行代码都不动、一个服务都不停。
API_ENV=/etc/fish/api-mail.env
# 先单独判可读。少了这一步，文件不存在 / 忘了 sudo 时：sed 非零 → 在 `set -o pipefail`
# 下整条管道非零 → 赋值那一行直接静默退出，运维看不到任何原因（实测 rc=1 且零输出）。
if [ ! -r "$API_ENV" ]; then
  echo "预检失败：读不到 $API_ENV。脚本要 sudo 执行；无 systemd 的容器环境见 §11。" >&2
  exit 1
fi
# 重复行按最后一行取；同文件里出现两行 MEETUP_TOKEN_SECRET 本身就该先清掉。
MEETUP_KEY=$(sed -n 's/^MEETUP_TOKEN_SECRET=//p' "$API_ENV" | tail -1 | tr -d '\r')
# 只验长度不够：仓库里那两行占位值本身就 ≥32 字符，照抄过来会带着公开密钥上线。
bad=0
case "$MEETUP_KEY" in
  '' | dev-only-* | ci-only-* | REPLACE_*) bad=1 ;;
  ?*) [ "${#MEETUP_KEY}" -ge 32 ] || bad=1 ;;
esac
if [ "${bad:-0}" -eq 1 ]; then
  echo "预检失败：$API_ENV 里的 MEETUP_TOKEN_SECRET 缺失、少于 32 字符，或还是 .env.example / CI 的占位值。" >&2
  echo "按 §4 现生成一个再发布；本次未改动代码，也未停任何服务。" >&2
  exit 1
fi
unset MEETUP_KEY

# 同一理由：#141 起 AI_POLISH_TRANSPORT 也是必填且无默认值，缺了同样在第 6 步进 crash loop。
AI_TRANSPORT=$(sed -n 's/^AI_POLISH_TRANSPORT=//p' "$API_ENV" | tail -1 | tr -d '\r')
AI_BASE_URL=$(sed -n 's/^AI_POLISH_BASE_URL=//p' "$API_ENV" | tail -1 | tr -d '\r')
AI_API_KEY=$(sed -n 's/^AI_POLISH_API_KEY=//p' "$API_ENV" | tail -1 | tr -d '\r')
AI_MODEL=$(sed -n 's/^AI_POLISH_MODEL=//p' "$API_ENV" | tail -1 | tr -d '\r')
ai_bad=0
case "$AI_TRANSPORT" in
  stub)
    # stub 也是真 HTTP 服务（apps/api/scripts/ai-polish-stub.ts），base_url 同样必填。
    [ -n "$AI_BASE_URL" ] || ai_bad=1 ;;
  live)
    { [ -n "$AI_BASE_URL" ] && [ -n "$AI_MODEL" ]; } || ai_bad=1
    case "$AI_API_KEY" in '' | REPLACE_*) ai_bad=1 ;; esac ;;
  *) ai_bad=1 ;;
esac
if [ "${ai_bad:-0}" -eq 1 ]; then
  echo "预检失败：$API_ENV 里的 AI_POLISH_* 不完整。transport 必须显式 stub 或 live；live 还要求 BASE_URL / API_KEY / MODEL 齐全，且 API_KEY 不是占位值。" >&2
  echo "按 §4 补齐后重试；本次未改动代码，也未停任何服务。" >&2
  exit 1
fi
unset AI_TRANSPORT AI_BASE_URL AI_API_KEY AI_MODEL

# 发布的就是这个 ref：默认 origin/main，回滚时传 tag 或 sha（§7.3）。
# 刻意不用 `git pull`：回滚后 HEAD 可能是 detached，裸 pull 会以
# "You are not currently on a branch" 直接失败——而那时服务已经被停掉了。
REF=${FISH_REF:-origin/main}

# 1) 取代码。放在停服务之前：这一步失败（网络/ref 打错）不该带来任何停机。
sudo -u fish -H git fetch --all --tags
sudo -u fish -H git checkout -f "$REF"

# 2) 依赖。不要裁剪 devDependencies，理由见 §4。
sudo -u fish -H /usr/local/bin/bun install --frozen-lockfile

# 3) 停服务：worker 必须先停，避免迁移期间有 job 正在执行；
#    api 顺带一起停，避免迁移出的新 schema 被旧代码读到。
systemctl stop fish-worker fish-api

# 4) 迁移（先于启动新代码）
sudo -u fish -H /usr/local/bin/bun run db:migrate

# 5) 前端产物
sudo -u fish -H /usr/local/bin/bun run build
rsync -a --delete /srv/fish/apps/web/dist/ /var/www/fish/

# 6) 起服务
systemctl start fish-api
systemctl start fish-worker

# 7) 验收（见 §8）
curl -fsS http://127.0.0.1:3000/health
```

本脚本是**幂等**的：任何一步失败后修好原因重新执行即可，不需要额外回退动作。

代价是第 3–6 步之间数十秒停机：API 的 WebSocket 连接由进程内 hub 维护
（`apps/api/src/modules/realtime/hub.ts`），重启即断；worker 也只能单实例，做不了滚动发布。
当前阶段接受这个停机；要做零停机得先改代码，不在部署范畴内。

### 7.3 回滚

回滚 = 用同一个发布脚本、把 ref 换成要回退到的 tag 或 sha：

```bash
cd /srv/fish && sudo -u fish -H git log --oneline -5 origin/main   # 找到目标版本
sudo FISH_REF=<tag|sha> /usr/local/bin/fish-deploy
```

不要手工 `git checkout <sha>` 后再指望下一次发布能自己走回 `main`：那会进入 detached HEAD，
而 §7.2 的脚本用的是显式 ref（`git checkout -f "$REF"`），它**不会**跟着分支自动前进。
这正是 §7.2 放弃 `git pull`、改用显式 ref 的原因。

**回滚代码不会回滚数据库。** 本仓的迁移只有前进方向（`packages/db/src/migrations/**` 不允许
改历史）。如果某次迁移是破坏性的，回滚代码后旧代码可能对不上新 schema。

因此更准确的说法是：**服务器上的 ref 回退只用于应急**；需要长期生效的回退应该在 `main` 上
`git revert` 后重新发布一个前进版本。

## 8. 上线验收

```bash
# 1) API + DB（503/degraded 表示 API 活着但连不上库）
curl -sS http://127.0.0.1:3000/health
# 期望 200 + {"status":"ok",...,"db":{"status":"up",...}}

# 2) 经反代走一遍同样的链路（验证 /api 前缀剥离）
curl -sS https://fish.example.com/api/health

# 3) WebSocket 回显。**打 API 端口，不走反代**：/ws 是无鉴权的开发用入口，
#    公网暴露面上没有它（见 §6 与 §9 第 11 条）。
cd /srv/fish && WS_URL=ws://127.0.0.1:3000/ws /usr/local/bin/bun run ws:smoke
# 要顺带验证反代的 Upgrade 透传，就用业务通道 /ws/chat（无 cookie 时应回 401，不是 404）：
#   curl -s -o /dev/null -w '%{http_code}\n' -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
#     -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
#     https://fish.example.com/ws/chat

# 4) SPA 与静态产物
curl -sI https://fish.example.com/ | head -1                 # 200
curl -s  https://fish.example.com/login | grep -q '<div id="root">' && echo SPA-fallback-ok

# 5) 对象存储。两条都得验，因为浏览器与 API 进程走的是同一个地址：
#    ① 服务端可达（API 的 stat() 用这个）——在**服务器上**执行：
curl -s -o /dev/null -w '%{http_code}\n' https://s3.fish.example.com/fish/<objectKey>   # 200，不应是 403
#    ② 浏览器可达（图片直链）——在你自己电脑上执行同一条命令
#    任一条失败：网站能开但传图后报「图片尚未上传完成」（§9 第 4 条）

# 6) 面交码签名密钥（#70）到位。缺它时 API **根本不会 listen**，所以第 1 步的 curl 连不上
#    就是它的信号。这里再确认它没有陷在 crash loop 里（缺失/过短/占位值 → 每 5 秒重启一次），
#    要等过一个 RestartSec=5 的周期再判。窗口只取本次发布之后：`-b` 覆盖整次开机，
#    上一次失败的记录会让已经修好的发布假失败。
sleep 6
systemctl is-active fish-api        # 期望 active（不是 activating / failed）
sudo journalctl -u fish-api --since '-5 min' --no-pager | wc -l   # 必须 > 0：0 行是读不到日志，不是通过
sudo journalctl -u fish-api --since '-5 min' --no-pager | grep '环境变量校验失败' || echo '无环境变量校验失败 ✓'

# 7) 手动验收一条业务链：注册 → 登录 → 发布商品并传图 → 愿望 → 匹配 → 聊天
#    → 提案 / 接受（→ PENDING_MEETUP）→ 卖家签发面交码 → 买家核销 → 双方确认齐
#      → COMPLETED + 商品 SOLD。核销只在同一事务里盖**卖家**确认（展示码即卖家同意，
#      apps/api/src/modules/transactions/store.ts 的 consumeMeetupToken）；若买家此前没单侧
#      confirm 过，核销后仍需买家调一次 confirm 才会 COMPLETED——按响应里的 nextAction 走。
```

`bun run core:smoke` **只在开发/预发机跑**：它会自建 scratch 库、并 spawn 自己的 API 与 Worker
进程（`apps/api/scripts/core-smoke.ts` 头部注释），在生产机上等于多起一个 worker，且需要
`CREATEDB` 权限。

## 9. 硬约束与坑清单

1. **worker 单实例**。启动时的僵死 job 回收假设「看到的 `RUNNING` 必然属于已死进程」
   （[architecture.md](architecture.md) §5.3、`apps/worker/src/index.ts` 的 `recoverStaleClaims`）。
   第二台机器/第二个进程一起跑，会把对方正在执行的 job 抢回去重复执行。
   - 不要在部署机上跑 `bun test`、`bun run core:smoke` 或 `bun run dev:worker`。
   - 需要扩容时必须先把回收语义换成 `locked_at` + 续租（代码改动，另开 Issue）。
2. **`/api` 前缀只在反代层剥**。API 路由是根级的；反代若把 `/api/health` 原样转过去就是 404。
3. **`db:seed` 的守卫只看 hostname**（`packages/db/src/seed.ts:284`）。同机部署恒为 `127.0.0.1`，
   守卫不拦，生产禁用。
4. **`S3_ENDPOINT` / `S3_PUBLIC_URL` 必须同时对“服务端”与“浏览器”可达**：
   - 图片是**客户端直传**：`presign` 返回的 URL 由 `Bun.S3Client` 按 `S3_ENDPOINT` 的 host 签名
     （`apps/api/src/modules/uploads/storage.ts`），浏览器直接 `PUT` 它
     （`apps/web/src/features/sell/api.ts:61`）。写成 `http://127.0.0.1:9000` 只有服务器能访问，上传必失败。
   - **服务端也要能访问同一个地址**：上传确认时 API 会调 `storage.stat()`（`apps/api/src/modules/uploads/service.ts`），
     它走的是同一个 `S3Client`/同一个 `S3_ENDPOINT`。而 `stat()` 把**任何**失败都降级成 `null` → 接口返回 422
     `UPLOAD_OBJECT_MISSING`「图片尚未上传完成」，报错指向的原因和真实原因（服务端连不上对象存储）不一致。
     若服务器无法 hairpin 到自己的公网地址，在 `/etc/hosts` 里把该域名指回 `127.0.0.1`
     （证书按 SNI 名签发，仍然有效），并在 §8 验收里用服务端 `curl` 一个真实存在的 object key 把它验出来。
   - 读接口返回的图片 URL 是 `S3_PUBLIC_URL + '/' + objectKey`，必须能从浏览器打开。
   - 正因如此，MinIO 要有暴露面：本手册用 `s3.<域名>` 反代并**保留 Host**（§6）。SigV4 签名覆盖
     `Host`，反代改写 Host 会让 PUT/GET 变成 403。
   - **不能把 MinIO 挂在路径前缀下**（如 `https://主站/s3`）：Bun 1.4.0 的 presign 会把前缀
     一起签进 canonical URI，而 MinIO 把路径第一段当桶名。实测证据与替代方案见 §11。
5. **`WEB_ORIGIN` 必须与浏览器地址逐字符一致**（无尾斜杠），它同时是 CORS 白名单与会话 cookie
   的 `Secure` 开关（`apps/api/src/app.ts` 的 `secureCookie: env.WEB_ORIGIN.startsWith('https://')`）。
   公网部署必须 `https://`；内网明文部署只能是 `http://`（见 §11），此时 cookie 不带 `Secure`，
   仅限内网使用。
6. **依赖清单不能裁剪**（§4 的 `--frozen-lockfile` + 保留 devDependencies）。
7. **不要提交 `.env`**；只维护 `.env.example`。生产密钥不进 git、不进备份压缩包的明文目录。
8. **`GET /health` 的 `version` 恒为 `0.0.0`**（`apps/api/src/version.ts` 硬编码）。别拿它判断
   线上跑的是哪个版本，要用 `git -C /srv/fish rev-parse HEAD`。
9. **单机单点**：Postgres、MinIO、API、Worker 都在一台机器上，任何一块坏了整站不可用；§10 的备份
   是唯一的恢复手段。
10. **HTTPS 是硬需求**：产品是移动端 PWA，且会话 cookie 依赖 Secure。同时反代证书续期失败会直接
    让整站不可访问，需要监控。（内网明文部署是例外，见 §11。）
11. **`/ws` 是无鉴权的 echo 入口**：`apps/api/src/app.ts` 的 `app.get('/ws', upgradeWebSocket(...))`
    只回显文本帧，不做任何认证，仅供链路冒烟。反代不要暴露它（§6 只放 `/ws/*`），验收时打回环
    地址（§8 第 3 步）。业务通道是 `/ws/chat`（`packages/contracts/src/chat/routes.ts`）。

12. **`MEETUP_TOKEN_SECRET` 是签名密钥，不是普通配置项**（#70，见 §4）：
    - 缺失或短于 32 字符 → API 启动即抛 `环境变量校验失败：MEETUP_TOKEN_SECRET …`
      （`packages/shared/src/env.ts` 的 `loadMeetupTokenEnv`），配合 `Restart=always`
      表现为每 5 秒一次的 crash loop，`/health` 根本连不上。这就是 §7.2 第 0 步预检的理由。
    - **换值 = 已签发未核销的面交码立刻全部失效**：库里只存带密钥的 HMAC，比对随密钥变，
      买家拿到 422 `MEETUP_TOKEN_INVALID`，卖家重新取码即恢复（#175 起码本身也由密钥派生，
      换值后连卖家看到的码值一起变）。方向是 fail closed（不会误放行）。
      窗口约束：凭证在 `PENDING_MEETUP` 期间长期有效（#147 起没有 TTL），换值后卖家重新
      取码会拿到新派生码并同步比对列，所以只需避开"正站在原地扫码的那一对"，
      不需要等全站没有 `PENDING_MEETUP` 交易（活跃站上那种窗口几乎不存在）。
    - 顺带知道两件不影响部署但会被问到的事：面交凭证的失败计数是**累计**的，QR 与 6 位码共用
      同一个计数（`apps/api/src/modules/transactions/service.ts` 的 `consumeMeetup`）——满 5 次锁 10 分钟，
      锁定到期后计数**不**归零，再错一次立即重新锁定；只有卖家重新取码才清零
      （`store.ts` 的 `recordMeetupTokenFailure` 与 `upsertMeetupToken`）。所以现场"输对了却还说错误次数过多"
      的正解是请卖家重新出示一次（重新进面交页 / 点刷新；#175 起码值不变、只解锁），不是等一会儿。
    - 它**会**随 §10 备份脚本那条 `tar` 里已列出的 `/etc/fish/api-mail.env` 一起进
      `config-*.tar.gz`：换机恢复后未核销码仍然可用。也正因如此，**备份包与数据库同等保密**，
      拿到 config 包就等于能离线伪造任意面交码。
      ⚠️ 这与本节第 7 条"生产密钥不进备份压缩包的明文目录"字面冲突：第 7 条要防的是明文散落，
      而 §10 的 config 包是唯一的换机恢复手段，两者只能靠"备份目录权限 + 异地介质加密"同时满足。
      是否要把密钥从备份包里排除（代价：恢复时必须重生成密钥、所有未核销码作废），留给审核定。
    - 回滚到 #70 之前的 ref 时它变成多余项，无害；但 §7.2 的预检会一直要求它在，
      别因为「这次回滚用不到」就删掉文件。

## 10. 运维

### 备份（必须做，且要演练恢复）

口令与 `mc` 的 alias 不写在脚本里，单独放 `/etc/fish/backup.env`（`chown root:root`、
`chmod 600`）：

```bash
# /etc/fish/backup.env
DB_PASSWORD=<数据库口令>
# mc 不认识 §3 里 export 的那个 MC_HOST_local（那只存在于你当时的交互 shell 里），
# cron 环境是干净的： 不给它 alias，整段脚本会因为 set -eu 直接中止，
# 对象与配置备份会**静默缺失**。所以这里必须再声明一次。
MC_HOST_local=http://fish-app:<应用账号口令>@127.0.0.1:9000
```

```bash
#!/bin/sh
# /etc/cron.daily/fish-backup
# shebang 必须在**第一行**；必须 chmod +x（cron.daily 只执行可执行文件，
# 权限不对就是“安静地不备份”）。
set -eu
. /etc/fish/backup.env

STAMP=$(date +%F)
TMP=$(mktemp -d /var/backups/fish/.tmp-XXXXXX)
trap 'rm -rf "$TMP"' EXIT

# 数据库：先写临时文件再原子改名——否则失败时会留下一个看起来正常、实际上是截断的备份
PGPASSWORD="$DB_PASSWORD" pg_dump -h 127.0.0.1 -U fish -Fc fish > "$TMP/db-$STAMP.dump"
mv "$TMP/db-$STAMP.dump" /var/backups/fish/db-$STAMP.dump

# 对象存储：**不要 tar 运行中的数据目录**（MinIO 的 xl.meta 与数据文件在并发 PUT/DELETE 下
# 不是一致性快照）；用 mc mirror。
# ⚠️ 镜像到同一块盘**不构成容灾**：那块盘坏了两份一起没。目标应是挂载的第二块盘，
#    或远端 alias（如 `mybackup:fish`）。
mc mirror --overwrite --remove local/fish "${MINIO_BACKUP_TARGET:?请在 backup.env 里指定非本机盘的目标}"

# 配置与变量：systemd 单元、MinIO 策略、证书存储都要进，否则换机器恢复时要重新推导，
# 重新签发证书还可能撞上 CA 的速率限制。证书目录不存在时会报警告（--ignore-failed-read）
tar czf "$TMP/config-$STAMP.tar.gz" --ignore-failed-read \
  /srv/fish/.env /etc/fish/api-mail.env /etc/fish/backup.env /etc/default/minio /etc/minio-app-policy.json \
  /etc/caddy/Caddyfile /var/lib/caddy/.local/share/caddy \
  /etc/systemd/system/fish-api.service /etc/systemd/system/fish-worker.service \
  /etc/systemd/system/minio.service
mv "$TMP/config-$STAMP.tar.gz" /var/backups/fish/config-$STAMP.tar.gz

# 只清过期的**文件**，不要误删 minio/ 镜像目录（-maxdepth 1）
find /var/backups/fish -maxdepth 1 -type f -mtime +14 -delete
```

```bash
sudo chmod 600 /etc/fish/backup.env
sudo chown root:root /etc/cron.daily/fish-backup && sudo chmod +x /etc/cron.daily/fish-backup
# 上线后手跑一次，确认三个产物都在（dump / config 包 / 对象镜像目录）
sudo /etc/cron.daily/fish-backup && ls -la /var/backups/fish
```

恢复演练（**在另一台机器上做**，别在生产直接试；dump 文件与镜像目录要先拷过去）。
演练机是干净的，所以下面几样都要现场重建：

```bash
# 1) 角色：dump 里对象的属主是 fish，演结机没这个角色就恢复不了
sudo -u postgres psql -c "CREATE ROLE fish LOGIN PASSWORD '<同一口令>';"
# 2) 建库：fish 角色默认 NOCREATEDB，建库必须用超级用户
sudo -u postgres createdb -O fish fish_restore
# 3) 恢复数据
PGPASSWORD=<口令> pg_restore -h 127.0.0.1 -U fish -d fish_restore db-<日期>.dump

# 4) 对象：alias 与目标桶都要现建（mc mirror 不会凭空造出桶）
mc alias set local http://127.0.0.1:9000 <ak> <sk>
mc mb --ignore-existing local/fish-restore
mc mirror --overwrite /var/backups/fish/minio/fish local/fish-restore
```

演练至少要确认三件事：`pg_restore` 能跑完（不是只看到文件存在）、回灌后能匿名 GET 到对象（200）、
以及 `config-*.tar.gz` 里的 `.env` 与证书目录确实在。

### 日志与健康

```bash
journalctl -u fish-api -f          # 应用用 console.* 输出纯文本行，由 systemd 收进 journald
journalctl -u fish-worker --since today
journalctl -u fish-api -p err
```

（仓库里没有 logger 模块：日志是 `console.log('[api] listening on …')` 这类手写文本，见
`apps/api/src/index.ts` 与 `apps/api/src/app.ts` 的 `console.error('[api] 未捕获异常', …)`。
要结构化日志得另外引入。）

对外监控直接探 `https://fish.example.com/api/health`：DB 断开时它返回 **503 + `status: degraded`**
（`apps/api/src/app.ts` 的 `/health`），这是唯一现成的健康信号。

### 常用排查

| 现象 | 先看哪里 |
| --- | --- |
| api 起不来，日志 `环境变量校验失败` | 看冒号后半句判断是哪一份配置：`…（参考 .env.example）` = `/srv/fish/.env` 少项（worker 也需要 `S3_*` 与 `WEB_ORIGIN`）；`… MAIL_TRANSPORT …` / `… MEETUP_TOKEN_SECRET …` / `… AI_POLISH_TRANSPORT …` = `/etc/fish/api-mail.env` 少项或还是占位值（§4） |
| 页面能开但接口 404 | 反代没剥 `/api` 前缀（§9 第 2 条） |
| 图片 403 | bucket 没设匿名读（§3 的 `mc anonymous set download`） |
| 图片地址不可达 / 上传失败 | `S3_ENDPOINT` / `S3_PUBLIC_URL` 写成了**只有服务器**能访问的地址（`127.0.0.1` / 容器名），见 §9 第 4 条 |
| 登录后立刻变未登录 | `WEB_ORIGIN` 与真实地址不一致，或不是 `https://` |
| 愿望一直不匹配 | 看 `journalctl -u fish-worker`；再确认只有这一个 worker 在跑 |

## 11. 附录：目标环境只给一个端口时（内网 / 已给定容器）

有些环境（课程或公司分配的容器）只把一个端口映射给你，例如宿主 `8101 → 容器 3000`，浏览器只能
访问 `http://10.223.24.16:8101`。本附录说明这种约束下怎么改，其余章节不变。

### 11.1 端口分配

| 进程 | 容器内监听 | 对外 |
| --- | --- | --- |
| Caddy | `0.0.0.0:3000` | 宿主 `8101`（唯一暴露面） |
| api | `3100`（`API_PORT`） | 不暴露 |
| worker | 无端口 | — |
| PostgreSQL | `127.0.0.1:5432` | 不暴露 |
| MinIO | `127.0.0.1:9000` | 不暴露，经 Caddy 的 `/fish/*` 出去 |

Caddy 必须绑 `0.0.0.0:3000`：Docker 的端口映射转发到容器 eth0，绑回环收不到。

### 11.2 MinIO 不能用路径前缀挂（实测结论）

想省一个端口，最自然的做法是把 MinIO 挂在 `http://<ip>:8101/s3`。**这条路走不通。**
在本机用 Bun 1.4.0 + 真实 MinIO 逐项测过：

| 预签名 `S3_ENDPOINT` | 直传 PUT | 说明 |
| --- | --- | --- |
| `http://host:19000`（无路径） | **200** | 基线 |
| `http://host:19998/s3`，反代剥 `/s3` | **403** `SignatureDoesNotMatch` | Bun 把 `/s3` 也算进了 canonical URI |
| `http://host:19997/s3`，反代不剥 | **400** `InvalidBucketName`（bucket=`s3`） | 签名已通过，是 MinIO 把路径第一段当桶名 |

正确的做法是**让桶名充当路径第一段**：`S3_ENDPOINT` 填**不带任何路径**的应用地址，于是
`S3_BUCKET=fish` 天然的 URL 就是 `/fish/<key>`，反代把 `/fish/*` 原样转给 MinIO 即可。
同一次实测里这条路径的 PUT 为 200、匿名 GET 为 200（字节一致）、服务端 `stat()` 也正常。

### 11.3 `.env`（只列与主文不同的项）

```bash
API_PORT=3100                                  # 3000 让给 Caddy
WEB_ORIGIN=http://10.223.24.16:8101            # 与浏览器地址逐字符一致（内网明文）
S3_ENDPOINT=http://10.223.24.16:8101           # ⚠️ 不带任何路径
S3_PUBLIC_URL=http://10.223.24.16:8101/fish    # 读接口拼出的前缀
S3_BUCKET=fish                                 # 桶名 = Caddy 里的 /fish/* 路由，改名要一起改
```

代价：`S3_ENDPOINT` 等于应用地址，API 进程自己的 `stat()` 会经宿主端口绕一圈（hairpin NAT）。
标准 Docker 端口映射能过；若日志里 `stat` 超时，先查这里。

### 11.4 Caddyfile

```caddyfile
# 站点地址不带主机名（:3000）：内网没有可签的域名，Caddy 不会去申请证书。
# 也不要开 encode：S3 的对象响应没必要压缩，避开动 Content-Length / Range。
:3000 {
	handle /api/* {
		uri strip_prefix /api
		reverse_proxy 127.0.0.1:3100
	}

	# 业务实时通道。不放 `/ws`：那是无鉴权的 echo 冒烟入口（§9 第 11 条）
	handle /ws/* {
		reverse_proxy 127.0.0.1:3100
	}

	# MinIO：路径原样转发（bucket 名就是第一段），**不要改写 Host**——SigV4 覆盖 host
	handle /fish/* {
		reverse_proxy 127.0.0.1:9000
	}

	handle /assets/* {
		root * /var/www/fish
		header Cache-Control "public, max-age=31536000, immutable"
		file_server
	}

	handle {
		root * /var/www/fish
		header Cache-Control "no-store"
		try_files {path} /index.html
		file_server
	}
}
```

`handle` 按书写顺序匹配，`/fish/*` 必须在兜底之前。仓库现有前端路由没有 `/fish` 前缀
（`/`, `/wish`, `/search`, `/match`, `/profile`, `/mylist`, `/notifications`, `/publish`,
`/orders`, `/message`, `/login`, `/register`, `/category`, `/user/*`, `/chat/*`, `/detail/*`,
`/watchers/*`），不冲突。

### 11.6 容器里没有 systemd 时的代替方案

很多课程/公司分配的容器**没有 init**（PID 1 不是 systemd，`systemctl` 二进制在但 `/run/systemd/system`
不存在）。先确认：

```bash
ps -p 1 -o comm= ; ls -d /run/systemd/system 2>/dev/null || echo "无 systemd"
```

无 systemd 时 §5 的单元文件完全用不上。可行做法（按推荐顺序）：

1. **supervisor**（apt 里有）：为 `fish-api` / `fish-worker` / `caddy` 各写一个 `[program:x]`，
   用 `user=` 降权、`autostart=true` / `autorestart=true`、`stdout_logfile=` 收日志；
   `supervisord -c …` 启动，`supervisorctl status/restart` 控制。这是最接近 systemd 行为的一种。
   ⚠️ 没有 `EnvironmentFile` 可用时，**§4 列出的全部 API 专属变量**（邮件三项、#70 的
   `MEETUP_TOKEN_SECRET`、#141 的四个 `AI_POLISH_*`）必须由 `fish-api` 的 `environment=`
   注入——少任意一项 API 都起不来，带着 `autorestart=true` 反复重启，症状与 §9 第 12 条一致。
   清单以 §4 为准（这里不再逐个列，避免像本节原先那样漏掉后加的变量）。
   `environment=` 用逗号分隔且值里带空格（`RESEND_FROM` 就是 `鱼小应 <…>`），那一项要按
   supervisor 的规则加引号；`supervisord.conf` 本身收到 `root:root 600`，别放世界可读的目录。
   （supervisor 的引号细则本机未实测。）
2. `cron` + `@reboot`：能开机能拉起来，但没有崩溃自恢复，也没有依赖顺序（worker 会在迁移前先起）。

⚠️ **两者都需要有人先启动它**：容器重启后，若 entrypoint 不拉起 supervisord/cron，服务不会自己回来。
此事只能由分配环境的人（老师/平台）在容器启动命令里加一行，本文档无解；**上线时要问清楚**。

另外，无 systemd 时日志不在 journald：看 supervisor 的 `stdout_logfile`（或容器自身的日志）。§10
里 `journalctl -u …` 的几条命令相应换成看日志文件。

### 11.7 验收

```bash
curl -sS http://10.223.24.16:8101/api/health                      # 200 status ok / db up
cd /srv/fish && WS_URL=ws://127.0.0.1:3100/ws bun run ws:smoke    # /ws 只在回环验（无鉴权）
curl -s  http://10.223.24.16:8101/login | grep -q 'id="root"'
# 图片（§11.2 已验证的路径）：发布页传一张图，再直开返回的 URL，应为 200
```

## 12. 本手册的验证边界

- 仓库侧的事实（脚本、入口、环境变量、路由前缀、`presign` 行为、seed 守卫、worker 回收语义）
  都来自本仓库源码与 `docs/`，行号已在上文给出。
- §11.2 的 MinIO 结论、§3 的镜像取二进制、以及在 aarch64 Ubuntu 上的迁移/构建均经**实测**
  （本机 Bun 1.4.0 + MinIO 四种组合逐项验证；aarch64 上 `bun install --frozen-lockfile`、
  `bun run build`、`db:migrate`、`/health`、`ws:smoke` 均已跑通），不是推论。
- **主文（§1–§10）未在真实 Ubuntu 机器上完整跑过一遍**：systemd 单元、Caddyfile、备份脚本属于
  按仓库事实推导出的配置，首次上线请按 §8 逐步验收，不要跳步。
- 生产形态确定后，应同步更新 [architecture.md](architecture.md) §4 的运行时拓扑。
