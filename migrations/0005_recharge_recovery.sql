BEGIN;

-- 生产目标：领取任务使用租约令牌，写回时比较令牌；终态不能被迟到的 Worker 覆盖。
ALTER TABLE fulfillment_attempts
  ADD COLUMN lease_token uuid,
  ADD COLUMN supplier_lookup_token_iv bytea,
  ADD COLUMN supplier_lookup_token_auth_tag bytea,
  ADD COLUMN supplier_lookup_token_key_version text,
  ADD COLUMN supplier_lookup_token_cleared_at timestamptz;

ALTER TABLE cdk_vouchers ADD COLUMN issue_lease_token uuid;

-- 一个 Quefa 订单同时最多有一个待处理、处理中或成功的履约。
CREATE UNIQUE INDEX fulfillment_one_active_order_idx
  ON fulfillment_attempts(merchant_id, order_id)
  WHERE status IN ('queued', 'running', 'succeeded');

-- 回调去重与业务结果必须在同一事务中落库。
ALTER TABLE platform_supplier_webhook_events
  ADD COLUMN status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processed', 'failed'));
UPDATE platform_supplier_webhook_events SET status = 'processed' WHERE processed_at IS NOT NULL;

INSERT INTO schema_migrations(version) VALUES ('0005_recharge_recovery');
COMMIT;
