# SQLite 备份恢复自动演练

版本：2026-10-01  
状态：代码与隔离测试已完成；尚未部署生产，尚未形成生产 RPO/RTO 证据。

## 背景

当前单服务器应用主账本是 SQLite WAL。旧的每日任务确实会生成 SQLite 快照，但每周恢复服务验证的是未来 PostgreSQL 数据库，不能证明当前订单、支付、退款、钱包和核算数据可以从 SQLite 快照恢复。本次将两条链路分开：

- `verify-backup-restore.sh`：验证当前 SQLite 主账本备份；
- `verify-postgres-backup-restore.sh`：保留给未来 PostgreSQL 切换演练，不能作为当前主账本证据。

## 自动校验范围

`verify-sqlite-backup` 对传入的快照执行：

1. 原文件以只读方式打开，不运行应用迁移或初始化；
2. `PRAGMA integrity_check` 必须只返回 `ok`；
3. `PRAGMA foreign_key_check` 不得返回违规记录；
4. 必须存在 `sandbox_records` 与 `request_nonces`；
5. 所有业务 `payload` 必须是有效 JSON；
6. 对表、索引和 SQL 定义生成结构 SHA-256；
7. 按稳定顺序流式读取所有业务记录和 Nonce，生成逻辑 SHA-256，不把原文写进报告；
8. 使用 SQLite Backup API 恢复到新的临时数据库；
9. 对恢复库重复检查，并比较结构摘要、逻辑摘要、总记录数、Nonce 数和各记录类型数量；
10. 无论成功或失败都清理临时恢复目录，原备份不修改、不删除。
11. CLI 先完整解析位置参数与 `--report`（二者顺序均可），再规范化真实路径；若报告路径与输入备份为同一路径、符号链接别名或同一硬链接，立即拒绝，且在校验和写入前不触碰原备份。

成功报告只包含备份文件名、字节数、文件摘要、逻辑摘要、表名和数量，不包含订单内容、密钥、Session、支付凭据或上游 CDK。

## 运维入口

构建后验证任意隔离快照：

```sh
npm run build
npm run backup:verify -- /path/to/backup.sqlite --report /path/to/report.json
# 也支持：npm run backup:verify -- --report /path/to/report.json /path/to/backup.sqlite
```

报告路径绝不能指向备份自身。冲突时命令以非零状态退出并报告 `sqlite_backup_report_path_conflict`，不会用 JSON 覆盖 SQLite 文件。

服务器验证最新每日快照：

```sh
sudo sh /opt/recharge-platform/current/deploy/production/verify-backup-restore.sh
```

每日备份现在同时保存 `<snapshot>.sha256`；每周 systemd 任务先核验该清单，再执行隔离恢复，报告为 `<snapshot>.restore-report.json`，权限为 `0600`。

## 真实恢复边界

自动演练不会把恢复副本切换成生产数据库。真正灾难恢复必须经过人工确认：停止产生外部副作用的 Worker 和写入口，保留损坏文件及日志证据，在隔离目录恢复并核对财务总额与抽样时间线，使用 mock/断网环境验证后，再制定切流或向前补账方案。不得直接拿旧备份覆盖仍在变化的生产账本。

## 尚未完成

- 生产服务器安装本版本及启用更新后的 timer；
- 第一次生产快照隔离恢复报告和实际耗时；
- 异机加密复制、对象锁/不可变保留及外部失败告警；
- 连续增量或迁移到具备 PITR 的 PostgreSQL，因此当前本地日备份不满足 5 分钟 RPO；
- 生产数据库副本上的订单、钱包、佣金和每日核算汇总对账演练。

以上项目完成前，不得把本次本地自动测试表述为“生产灾备已经验收”。
