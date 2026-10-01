BEGIN;

ALTER TABLE products
  ADD COLUMN fulfillment_mode text NOT NULL DEFAULT 'direct'
    CHECK (fulfillment_mode IN ('direct', 'cdk')),
  ADD COLUMN supplier_product text NOT NULL DEFAULT 'gpt',
  ADD COLUMN supplier_plan text NOT NULL DEFAULT 'plus';

ALTER TABLE orders
  ADD COLUMN fulfillment_mode text NOT NULL DEFAULT 'direct'
    CHECK (fulfillment_mode IN ('direct', 'cdk')),
  ADD COLUMN supplier_product text NOT NULL DEFAULT 'gpt',
  ADD COLUMN supplier_plan text NOT NULL DEFAULT 'plus';

CREATE TABLE cdk_vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  order_id uuid NOT NULL,
  public_code text NOT NULL CHECK (public_code ~ '^QF-[A-Z0-9-]+$'),
  plan text NOT NULL,
  status text NOT NULL CHECK (status IN ('issuing', 'unused', 'reserved', 'consumed', 'failed', 'disabled')),
  supplier_provider text NOT NULL,
  supplier_cdk_id_ciphertext bytea,
  supplier_cdk_id_iv bytea,
  supplier_cdk_id_auth_tag bytea,
  key_version text NOT NULL,
  issue_attempts integer NOT NULL DEFAULT 0 CHECK (issue_attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  failure_code text,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (merchant_id, order_id) REFERENCES orders(merchant_id, id),
  UNIQUE (order_id),
  UNIQUE (public_code),
  UNIQUE (merchant_id, id),
  CHECK (
    status <> 'consumed'
    OR (supplier_cdk_id_ciphertext IS NULL AND supplier_cdk_id_iv IS NULL AND supplier_cdk_id_auth_tag IS NULL)
  )
);

ALTER TABLE sensitive_payloads
  DROP CONSTRAINT sensitive_payloads_owner_type_check,
  ADD CONSTRAINT sensitive_payloads_owner_type_check
    CHECK (owner_type IN ('fulfillment', 'cdk_voucher', 'api_key', 'webhook'));

ALTER TABLE fulfillment_attempts
  ADD COLUMN fulfillment_mode text NOT NULL DEFAULT 'direct'
    CHECK (fulfillment_mode IN ('direct', 'cdk')),
  ADD COLUMN voucher_id uuid,
  ADD COLUMN supplier_provider text,
  ADD COLUMN supplier_order_ref_ciphertext bytea,
  ADD COLUMN supplier_lookup_token_ciphertext bytea,
  ADD COLUMN supplier_status text,
  ADD COLUMN supplier_stage text,
  ADD COLUMN client_request_id text NOT NULL DEFAULT gen_random_uuid()::text,
  ADD COLUMN next_check_at timestamptz NOT NULL DEFAULT now(),
  ADD FOREIGN KEY (merchant_id, voucher_id) REFERENCES cdk_vouchers(merchant_id, id);

CREATE TABLE platform_supplier_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  client_request_id text,
  payload_hash text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processing_error text
);

ALTER TABLE cdk_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cdk_vouchers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cdk_vouchers
  USING (merchant_id = current_tenant_id())
  WITH CHECK (merchant_id = current_tenant_id());

REVOKE ALL ON platform_supplier_webhook_events FROM PUBLIC;

CREATE INDEX cdk_vouchers_merchant_status_idx ON cdk_vouchers(merchant_id, status, next_attempt_at, created_at);
CREATE INDEX fulfillment_due_idx ON fulfillment_attempts(worker_state, next_check_at, lease_until);
CREATE INDEX fulfillment_client_request_idx ON fulfillment_attempts(client_request_id);

INSERT INTO schema_migrations(version) VALUES ('0003_white_label_recharge');
COMMIT;
