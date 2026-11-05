# NAS 维护

维护现有站点前先读 [当前维护说明](../../docs/运维部署/站点维护说明.md) 和 [手动部署](../../docs/运维部署/生产环境手动部署.md)。首次安装的历史操作不代表当前生产开关或新闻数量。北京时间 2026-10-16 17:22:49 已从 `develop@965cb6e` 手动升级至 `3.5.2`，迁移、镜像和回退点见[本轮发布快照](../../docs/运维部署/站点维护说明.md#2026-10-16-模型配置与统计正式上线)；后续仍须现场核对。

`compose.sh` 加载三个既有私有覆盖，以及可选的最后镜像覆盖 `compose.release.yml`。该文件保留原名，供发布脚本或维护者固定 setup/API/worker/web 的镜像；发布默认只运行迁移，需显式设置 `SEED_TOPICS_ON_RELEASE=true` 才同步主题。私有覆盖不进入 Git 或镜像构建上下文；更新时保留生产环境文件、数据卷、worker 复用、并发和预算。

`compose.sh` 在调用 Docker 前用 `database-url.sh` 从 `DATABASE_HOST/USER/PASSWORD/NAME`（密码取 `DATABASE_PASSWORD` 或 `POSTGRES_PASSWORD`）生成百分号编码的 `DATABASE_URL`，只供旧镜像回退和兼容探针使用，新镜像仍走字段连接；脚本不输出密码。直接运行根目录 `docker compose` 时该变量为空，新镜像使用字段连接。

NAS 兼容镜像使用本目录的 Bookworm `Dockerfile`；不能换成根目录的 Trixie 镜像。标签构建 GHCR 镜像后，由煤球在所有者要求发布时按需运行脚本，见[自动发布](../../docs/运维部署/生产环境手动部署.md#自动发布)。

`auto-release.sh` 按需选择版本并通过 `compose.sh` 发布，不轮询。旧的部署状态及备份仅作为历史记录保留，不作为当前版本的依据；实际版本从正在运行的容器及镜像标签核对。
