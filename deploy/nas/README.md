# NAS 维护

维护现有站点前先读 [当前维护说明](../../docs/soymilk-operations.md) 和 [手动部署](../../docs/manual-deploy.md)。首次安装的历史操作不代表当前生产开关或新闻数量。

`compose.sh` 加载三个既有私有覆盖，以及可选的最后镜像覆盖 `compose.release.yml`。该文件保留原名，供维护者手动固定 setup/API/worker/web 的镜像及仅同步主题的 setup 命令。私有覆盖不进入 Git 或镜像构建上下文；更新时保留生产环境文件、数据卷、worker 复用、并发和预算。

NAS 兼容镜像使用本目录的 Bookworm `Dockerfile`；不能换成根目录的 Trixie 镜像。自动部署容器、轮询脚本、发布清单与 GitHub CI 已取消，更新由维护者手动执行。

`compose.sh` 不读取发布频道或执行自动更新。旧的部署状态及备份仅作为历史记录保留，不作为当前版本的依据；实际版本从正在运行的容器及镜像标签核对。
