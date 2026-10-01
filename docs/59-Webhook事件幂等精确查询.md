# Webhook 事件幂等精确查询

## 问题

业务状态变化在写入 Outbox 前必须检查 `eventKey`，防止相同支付、履约或退款事件重复通知。旧实现为了查一个事件键，会读取并解码该代理商的全部 Outbox 历史；事件越多，后续每一次状态变化越慢。

## 修改

- Repository 增加 `findOutboxByEventKey(merchantId, eventKey)` 精确查询能力。
- SQLite 直接使用 `sandbox_records(kind, merchant_id, unique_key)` 既有唯一索引定位事件。
- 内存仓储保留行为一致的精确方法，用于隔离测试。
- `WebhookService.emit` 优先精确查询；旧仓储实现仍保留兼容回退。
- `appendOutbox` 的数据库唯一约束继续作为并发竞态的最终防线。

## 验证

- 同一个 `eventKey` 连续写入两次返回同一个事件 ID。
- SQLite 路径不调用 `listOutbox`。
- Webhook 有界领取与签名投递测试继续通过。
