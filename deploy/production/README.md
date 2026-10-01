# 生产部署

当前单服务器、低订单量阶段使用 SQLite WAL 作为应用主存储，并保留已部署的 PostgreSQL 17 与 Redis 7.4 作为后续迁移基础。应用以 `NODE_ENV=production`、`EXECUTION_MODE=production` 运行；支付宝和生产上游均由工作台分别配置、验证和启用，部署本身不产生交易。平台不开放 USDT 新交易。

## 安全边界

- 公网主站仅开放开发文档、代理 API、支付/兑换页和外部回调；主域名拒绝 `/workspace`、`/internal/admin`、`/sandbox` 与健康检查。
- 管理后台只在 `admin.tibo.ink/workspace` 开放，使用独立账号、强制首次改密和 TOTP MFA；后台域名不提供 `/v1`、支付页或回调。
- 应用只绑定宿主机 `127.0.0.1:3200`，由 Caddy 终止 HTTPS。
- 生产 SQLite、环境文件和备份仅服务器受限账号可访问；加密主密钥不得进入数据库备份、镜像、源码、聊天或工单。
- 生产启动时不会创建演示商户；从预发布复制的数据会撤销演示密钥、停用演示应用并暂停演示商户。
- 开放 API 按 API Key 分读写固定窗口限流，默认每分钟读取 600 次、写入 120 次；可通过 `API_RATE_LIMIT_READ_PER_MINUTE` 和 `API_RATE_LIMIT_WRITE_PER_MINUTE` 调整。计数存于主账本数据库并由所有 API 进程共享，不能用单进程内存限流替代。

## 切换候选版本

候选镜像先完成本地测试与健康检查，再执行：

```sh
sudo sh deploy/production/deploy-production-candidate.sh /opt/recharge-platform/releases/<release> <candidate-image>
```

脚本会：

1. 备份当前环境文件与运行数据库并做完整性检查。
2. 首次生产切换时，在停止预发布容器后复制一致的生产数据库。
3. 原子切换 `current`，启动 `compose.production.app.yaml`。
4. 验证本机健康、开发者中心和 OpenAPI；失败时恢复旧版本、旧镜像、旧环境及旧容器。

`production.env` 强制设置生产运行形态，但新库中的支付通道和供应连接仍保持关闭，须在后台完成配置和验证后显式启用。

## 基础设施与备份

```sh
sudo docker compose -f compose.production.infra.yaml up -d
sudo sh deploy/production/verify-infrastructure.sh
sudo sh deploy/backup-prelaunch.sh
sudo sh deploy/production/healthcheck.sh
sudo install -m 0644 deploy/production/systemd/quefa-healthcheck.service /etc/systemd/system/
sudo install -m 0644 deploy/production/systemd/quefa-healthcheck.timer /etc/systemd/system/
sudo install -m 0644 deploy/production/systemd/quefa-health-alert@.service /etc/systemd/system/
sudo install -m 0644 deploy/production/systemd/quefa-backup.service /etc/systemd/system/
sudo install -m 0644 deploy/production/systemd/quefa-backup.timer /etc/systemd/system/
sudo install -m 0644 deploy/production/systemd/quefa-restore-test.service /etc/systemd/system/
sudo install -m 0644 deploy/production/systemd/quefa-restore-test.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now quefa-healthcheck.timer quefa-backup.timer quefa-restore-test.timer
```

`healthcheck.sh` 同时检查 API 就绪、Worker 持久化心跳、Worker 容器和公开路由边界；失败会触发独立 journald 告警事件。可在 root 所有、权限 `0600` 的 `/opt/recharge-platform/config/health-alert.env` 中配置 HTTPS `HEALTH_ALERT_WEBHOOK_URL`，向现有运维通知入口发送最小化告警。

同一脱敏通知器也由 `quefa-backup.service` 和 `quefa-restore-test.service` 的 `OnFailure` 调用。告警只携带失败单元、主机和 UTC 时间，不包含备份路径、数据库内容、健康响应或凭据；收到告警后再通过受控服务器日志定位失败原因。

`backup-prelaunch.sh` 会自动选择 `production.sqlite`，旧文件名仅为兼容现有 systemd 服务。每天执行 SQLite 一致性备份并保存 SHA-256 清单；`quefa-restore-test.timer` 每周把最新快照恢复到隔离临时库，对比结构摘要、逻辑摘要、记录总数、分类数量、JSON 与外键，报告保存在快照旁且不会替换实时账本。未来 PostgreSQL 演练保留在 `verify-postgres-backup-restore.sh`，不能用它代替当前 SQLite 主账本的恢复验证。上线真实收款前仍须增加异机加密备份并缩短 RPO。

手工验证指定快照：

```sh
sudo sh deploy/production/verify-backup-restore.sh /opt/recharge-platform/current /opt/recharge-platform/backups/production-app-<time>.sqlite
```

该命令只读原快照，恢复副本位于系统临时目录并在核验后删除。它证明快照可读取和逻辑一致，不代表已经完成异机灾备，也不会自动切换生产数据库。

扩展到多 API/Worker 节点、明显提高并发或启用更复杂的自动财务处理前，必须迁移 PostgreSQL Repository；不能让多个主机直接共享 SQLite 文件。
