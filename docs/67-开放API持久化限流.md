# 开放 API 持久化限流

版本：2026-10-01  
状态：本地实现与自动化验证完成，尚未部署生产。

## 边界

开放 API 在 HMAC 签名、密钥状态、来源 IP 和 API 授权校验通过后，按 `partner_id + key_id` 分别计算读取和写入请求。无效签名不会消耗合法代理额度；登录工作台、支付回调、供应回调和公开兑换入口不共用代理 API 额度。

默认固定一分钟窗口：

- 读取：每个 API Key 每分钟 600 次；
- 写入：每个 API Key 每分钟 120 次。

生产可通过 `API_RATE_LIMIT_READ_PER_MINUTE` 和 `API_RATE_LIMIT_WRITE_PER_MINUTE` 调整，取值范围 1–100000。限流不是代理余额、商品权限或交易风控的替代品。

## 一致性

计数写入主账本的 `request_rate_limits` 表，通过单条 SQLite UPSERT 在写事务中原子递增。多个 API 进程或连接读取相同数据库时共享同一额度，不依赖进程内存。每个 API Key 只保留读取、写入两个当前窗口桶，不随请求历史无限增长。

## 对接行为

认证成功的 `/v1` 响应返回：

- `X-RateLimit-Limit`：当前分桶额度；
- `X-RateLimit-Remaining`：当前窗口剩余额度；
- `X-RateLimit-Reset`：窗口重置的 Unix 秒时间戳。

超过额度时返回 HTTP 429、`rate_limited`、`retryable: true` 和 `Retry-After`。代理重试写请求时必须保留原业务 `Idempotency-Key`，重新生成时间戳与 Nonce；支付、充值和退款结果未知时先查原订单，不能因 429 重新开单或重复扣款。

## 自动化证据

- 读取与写入额度互不占用；
- 超限响应包含额度、剩余量、重置时间和退避秒数；
- 无效签名不消耗合法额度；
- 两个独立 SQLite Repository 连接对同一桶原子累计；
- 新窗口会把当前桶重置为第一次请求。

本阶段未对生产代理启用新额度，也未执行真实支付、充值或退款。
