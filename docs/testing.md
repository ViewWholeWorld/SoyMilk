# 隔离回归测试

测试只写入迁移完成的独立空库，数据库名必须以 `_test` 或 `_ci` 结尾。禁止连接生产库、挂载生产数据卷或复制环境文件及授权凭据。NAS 上用独立检查容器和 `--internal` Docker 网络，仅让检查容器与临时 PostgreSQL 相互连接；不发布数据库端口，不使用正式 Compose 项目运行测试。

## 模型替身与安全阀

`tests/setup.ts` 将采集、模型、飞书和 IndexNow 环境开关设为 false，隔离凭据目录，并为每个测试文件创建临时数据目录，退出时清理。未配置的模型连接使用空测试密钥和本机不可用地址，避免继承真实服务配置。

需要模型流程的用例先创建 `stub()`，再显式绑定：

```ts
import { stub, useModelStubs } from "./setup.ts";

const provider = await stub(() => ({ choices: [{ message: { content: '{"ok":true}' } }] }));
await useModelStubs({ DEEPSEEK: provider.url });
```

`useModelStubs` 只接受本测试进程由 `stub()` 创建且尚未关闭的服务，写入虚构的测试密钥，并临时开启内存中的模型入口；环境变量开关仍为 false。这样可以验证评分、回执、预算、归组与恢复流程，不调用真实模型。关闭安全阀的用例仍验证请求在发送前被拒绝。独立子进程测试必须显式指向本地替身，并在隔离网络内运行。

## 共享数据库与断言

整个套件按文件串行运行，因为用例共享预算及队列。文件之间的行即使有唯一标签，也可能被全库恢复扫描选中；涉及扫描时应检查本用例文章的完整任务集合及重复执行的稳定性，不能把全库返回数量当成本信源的数量。使用真实队列 worker 的用例要临时停放其他用例的任务，结束后恢复。

缓存前后的评分、决策、覆盖率和已记录 token 应相等；墙钟耗时分别验证为有限非负数。缓存会改变耗时，不能要求首次计算与缓存复用耗时相等，也不强制要求每次缓存调用都更快。

## 运行

```sh
npm run typecheck
DATABASE_URL=postgres://127.0.0.1:5432/soymilk_test node scripts/migrate.ts
DATABASE_URL=postgres://127.0.0.1:5432/soymilk_test npm test
npm run build -w @aihot/web
node --test apps/web/tests/*.test.ts
node scripts/smoke.ts --base http://实际站点地址:3000
```

后端测试需要带开发依赖的检查环境及 PostgreSQL 工具；NAS 的检查镜像、数据库和网络与生产服务独立。记录测试总数、失败及取消项；遇到失败先修正替身和隔离，再复核业务行为，不跳过断言或通过真实付费请求让测试变绿。冒烟检查使用真实访问主机，MCP 会拒绝未配置的内部容器别名。

2026-10-03 以独立空库完整核验：615 项全部通过，失败、取消、跳过均为 0；类型检查、31 项网页测试及 34 项正式站点冒烟检查通过。该结果是此轮验证快照，后续改动仍需重新运行。

同日北京时间 13:19，[GitHub Check #1](https://github.com/ViewWholeWorld/SoyMilk/actions/runs/37099294769) 在提交 `fd58b0c` 上完成，`check` 与 `docker` 作业均通过。完整后端回归仍为 615 项全部通过，失败、取消、跳过均为 0，耗时约 131 秒；与上述隔离空库基线一致。网页测试、空站点冒烟、MCP 合约及 Docker 构建启动检查通过；空站点的三个模型榜页面因尚无榜单数据按既有规则未检查，正式站点的 34 项只读冒烟另行全部通过。

同日自动更新功能在提交 `bfafb45` 的 [Check #6](https://github.com/ViewWholeWorld/SoyMilk/actions/runs/37107702823) 中通过 `check` 和 `docker` 作业：后端 621 项全部通过，失败、取消、跳过均为 0，约 144 秒；比前一基线增加 2 项上游合并测试和 4 项部署保护/回退测试。31 项网页测试、类型检查、网页构建、空站点冒烟与 MCP、Docker 检查通过。NAS 镜像发布及正式部署单独核验，不能由这些测试结果推定。
