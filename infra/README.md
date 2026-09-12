# infra

部署与基础设施配置。

## 当前状态（#1）

骨架阶段**本目录暂无实质内容**：本地依赖由根目录的 `docker-compose.yml` 托管（Postgres + MinIO），应用由宿主机 Bun 直接运行，因此还不需要独立的部署配置。

## 归属

`infra/**` 由 **zzstar101（Platform Owner）** 独占修改。

## 预期演进

后续引入真实部署（镜像构建、反向代理、CI/CD 发布、对象存储与数据库的生产环境接入）时，配置落在本目录，并在 [docs/architecture.md](../docs/architecture.md) 更新运行时拓扑。
