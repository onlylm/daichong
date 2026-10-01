BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE merchant_status AS ENUM ('onboarding', 'active', 'suspended', 'closed');
CREATE TYPE app_status AS ENUM ('active', 'disabled');
CREATE TYPE api_key_status AS ENUM ('active', 'expiring', 'revoked');
CREATE TYPE payment_status AS ENUM ('pending', 'paid', 'expired', 'closed', 'partially_refunded', 'refunded');
CREATE TYPE fulfillment_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');
CREATE TYPE refund_status AS ENUM ('requested', 'approved', 'processing', 'succeeded', 'failed', 'rejected', 'cancelled');
CREATE TYPE refund_type AS ENUM ('full', 'partial', 'price_adjustment');
CREATE TYPE settlement_status AS ENUM ('draft', 'reviewing', 'confirmed', 'paying', 'paid', 'failed', 'cancelled');
CREATE TYPE delivery_status AS ENUM ('pending', 'delivering', 'delivered', 'dead_letter');

CREATE TABLE schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Quefa 平台自有支付渠道配置。它不是租户资源，代理商 API 角色不得拥有此表权限。
CREATE TABLE platform_payment_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  config_ciphertext bytea NOT NULL,
  config_iv bytea NOT NULL,
  config_auth_tag bytea NOT NULL,
  key_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX platform_payment_configs_one_active_provider_idx
  ON platform_payment_configs(provider) WHERE status = 'active';

CREATE TABLE merchants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id text NOT NULL UNIQUE,
  name text NOT NULL,
  status merchant_status NOT NULL DEFAULT 'onboarding',
  settlement_cycle text NOT NULL DEFAULT 'weekly',
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, partner_id)
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_hash text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  mfa_enabled boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('active', 'disabled', 'locked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE merchant_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  code text NOT NULL,
  name text NOT NULL,
  permissions text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, code),
  UNIQUE (merchant_id, id)
);

CREATE TABLE merchant_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('invited', 'active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (merchant_id, role_id) REFERENCES merchant_roles(merchant_id, id),
  UNIQUE (merchant_id, user_id),
  UNIQUE (merchant_id, id)
);

CREATE TABLE partner_apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  app_id text NOT NULL,
  name text NOT NULL,
  status app_status NOT NULL DEFAULT 'active',
  allowed_ips inet[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, app_id),
  UNIQUE (merchant_id, id)
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  app_id uuid NOT NULL,
  key_id text NOT NULL UNIQUE,
  secret_ciphertext bytea NOT NULL,
  secret_iv bytea NOT NULL,
  secret_auth_tag bytea NOT NULL,
  key_version text NOT NULL,
  status api_key_status NOT NULL DEFAULT 'active',
  not_before timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  FOREIGN KEY (merchant_id, app_id) REFERENCES partner_apps(merchant_id, id),
  UNIQUE (merchant_id, key_id),
  UNIQUE (merchant_id, id)
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code text NOT NULL UNIQUE,
  name text NOT NULL,
  category text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'paused', 'retired')),
  currency char(3) NOT NULL DEFAULT 'CNY',
  max_quantity integer NOT NULL DEFAULT 1 CHECK (max_quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE merchant_product_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  product_id uuid NOT NULL REFERENCES products(id),
  status text NOT NULL CHECK (status IN ('active', 'paused', 'revoked')),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, product_id),
  UNIQUE (merchant_id, id)
);

CREATE TABLE merchant_price_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  product_id uuid NOT NULL REFERENCES products(id),
  supply_price_minor bigint NOT NULL CHECK (supply_price_minor >= 0),
  max_sale_price_minor bigint NOT NULL CHECK (max_sale_price_minor >= supply_price_minor),
  currency char(3) NOT NULL DEFAULT 'CNY',
  version integer NOT NULL CHECK (version > 0),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, product_id, version),
  UNIQUE (merchant_id, id)
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  app_id uuid NOT NULL,
  merchant_order_no text NOT NULL,
  product_id uuid NOT NULL REFERENCES products(id),
  price_rule_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  sale_amount_minor bigint NOT NULL CHECK (sale_amount_minor >= 0),
  supply_amount_minor bigint NOT NULL CHECK (supply_amount_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'CNY',
  payment_status payment_status NOT NULL DEFAULT 'pending',
  metadata jsonb NOT NULL DEFAULT '{}',
  paid_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (merchant_id, app_id) REFERENCES partner_apps(merchant_id, id),
  FOREIGN KEY (merchant_id, price_rule_id) REFERENCES merchant_price_rules(merchant_id, id),
  UNIQUE (merchant_id, merchant_order_no),
  UNIQUE (merchant_id, id)
);

CREATE TABLE payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  payment_config_id uuid NOT NULL REFERENCES platform_payment_configs(id),
  provider text NOT NULL,
  status text NOT NULL CHECK (status IN ('created', 'pending', 'paid', 'closed', 'failed', 'refunded')),
  provider_trade_no text,
  requested_minor bigint NOT NULL CHECK (requested_minor >= 0),
  received_minor bigint CHECK (received_minor >= 0),
  fee_minor bigint CHECK (fee_minor >= 0),
  qr_payload text,
  expires_at timestamptz NOT NULL,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (merchant_id, order_id) REFERENCES orders(merchant_id, id),
  UNIQUE (provider, provider_trade_no),
  UNIQUE (merchant_id, id)
);

CREATE TABLE fulfillment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  status fulfillment_status NOT NULL DEFAULT 'queued',
  failure_code text,
  message text,
  account_email_masked text,
  worker_state text NOT NULL DEFAULT 'queued' CHECK (worker_state IN ('queued', 'processing', 'polling', 'terminal')),
  lease_until timestamptz,
  upstream_ref_hash text,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (merchant_id, order_id) REFERENCES orders(merchant_id, id),
  UNIQUE (merchant_id, order_id, attempt_no),
  UNIQUE (merchant_id, id)
);

CREATE TABLE sensitive_payloads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  owner_type text NOT NULL CHECK (owner_type IN ('fulfillment', 'api_key', 'webhook')),
  owner_id uuid NOT NULL,
  ciphertext bytea,
  iv bytea,
  auth_tag bytea,
  wrapped_dek bytea,
  key_version text NOT NULL,
  cleared_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, owner_type, owner_id),
  UNIQUE (merchant_id, id),
  CHECK ((cleared_at IS NULL) OR (ciphertext IS NULL AND iv IS NULL AND auth_tag IS NULL AND wrapped_dek IS NULL))
);

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  merchant_refund_no text NOT NULL,
  type refund_type NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status refund_status NOT NULL DEFAULT 'requested',
  reason text NOT NULL,
  reviewed_by uuid,
  reviewed_at timestamptz,
  provider_refund_no text,
  failure_code text,
  refunded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (merchant_id, order_id) REFERENCES orders(merchant_id, id),
  UNIQUE (merchant_id, merchant_refund_no),
  UNIQUE (merchant_id, id)
);

CREATE TABLE ledger_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  event_type text NOT NULL,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  reversal_of uuid REFERENCES ledger_transactions(id),
  effective_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, event_type, source_type, source_id),
  UNIQUE (merchant_id, id)
);

CREATE TABLE ledger_entries (
  id bigserial PRIMARY KEY,
  transaction_id uuid NOT NULL,
  merchant_id uuid NOT NULL,
  account_code text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'CNY',
  public_type text,
  order_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (merchant_id, transaction_id) REFERENCES ledger_transactions(merchant_id, id),
  FOREIGN KEY (merchant_id, order_id) REFERENCES orders(merchant_id, id),
  UNIQUE (merchant_id, id)
);

CREATE TABLE settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  period_from timestamptz NOT NULL,
  period_to timestamptz NOT NULL,
  status settlement_status NOT NULL DEFAULT 'draft',
  gross_minor bigint NOT NULL DEFAULT 0,
  adjustment_minor bigint NOT NULL DEFAULT 0,
  payable_minor bigint NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'CNY',
  sealed_at timestamptz,
  paid_at timestamptz,
  payment_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_to > period_from),
  UNIQUE (merchant_id, period_from, period_to),
  UNIQUE (merchant_id, id)
);

CREATE TABLE settlement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  settlement_id uuid NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('merchant_margin', 'settlement_adjustment')),
  source_id uuid NOT NULL,
  order_id uuid NOT NULL,
  amount_minor bigint NOT NULL,
  original_settlement_line_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (merchant_id, settlement_id) REFERENCES settlements(merchant_id, id),
  FOREIGN KEY (merchant_id, order_id) REFERENCES orders(merchant_id, id),
  FOREIGN KEY (original_settlement_line_id) REFERENCES settlement_lines(id),
  UNIQUE (merchant_id, source_type, source_id),
  UNIQUE (merchant_id, id)
);

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  settlement_id uuid,
  title text NOT NULL,
  tax_id_ciphertext bytea,
  tax_id_iv bytea,
  tax_id_auth_tag bytea,
  key_version text,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'CNY',
  status text NOT NULL CHECK (status IN ('requested', 'reviewing', 'issued', 'rejected', 'voided', 'red_invoice')),
  invoice_no text,
  issued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (merchant_id, settlement_id) REFERENCES settlements(merchant_id, id),
  UNIQUE (merchant_id, id)
);

CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  url text NOT NULL CHECK (url ~ '^https://'),
  secret_ciphertext bytea NOT NULL,
  secret_iv bytea NOT NULL,
  secret_auth_tag bytea NOT NULL,
  key_version text NOT NULL,
  subscribed_events text[] NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, id)
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  event_key text NOT NULL UNIQUE,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, id)
);

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  outbox_event_id uuid NOT NULL,
  endpoint_id uuid NOT NULL,
  status delivery_status NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  delivered_at timestamptz,
  last_error_code text,
  response_status integer,
  response_excerpt text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (merchant_id, outbox_event_id) REFERENCES outbox_events(merchant_id, id),
  FOREIGN KEY (merchant_id, endpoint_id) REFERENCES webhook_endpoints(merchant_id, id),
  UNIQUE (merchant_id, outbox_event_id, endpoint_id),
  UNIQUE (merchant_id, id)
);

CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL,
  app_id uuid NOT NULL,
  route_key text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (merchant_id, app_id) REFERENCES partner_apps(merchant_id, id),
  UNIQUE (merchant_id, app_id, route_key, idempotency_key),
  UNIQUE (merchant_id, id)
);

CREATE TABLE state_transitions (
  id bigserial PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  from_state text,
  to_state text NOT NULL,
  reason_code text NOT NULL,
  reason text,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, id)
);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  merchant_id uuid REFERENCES merchants(id),
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  before_redacted jsonb,
  after_redacted jsonb,
  ip inet,
  user_agent text,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orders_merchant_created_idx ON orders(merchant_id, created_at DESC);
CREATE INDEX merchant_users_lookup_idx ON merchant_users(merchant_id, user_id);
CREATE INDEX payments_order_idx ON payment_attempts(merchant_id, order_id);
CREATE INDEX fulfillments_worker_idx ON fulfillment_attempts(worker_state, lease_until, created_at);
CREATE INDEX refunds_status_idx ON refunds(merchant_id, status, created_at);
CREATE INDEX ledger_entries_query_idx ON ledger_entries(merchant_id, id DESC);
CREATE INDEX settlements_query_idx ON settlements(merchant_id, period_to DESC);
CREATE INDEX invoices_query_idx ON invoices(merchant_id, status, created_at DESC);
CREATE INDEX outbox_created_idx ON outbox_events(created_at);
CREATE INDEX deliveries_due_idx ON webhook_deliveries(status, next_attempt_at, lease_until);
CREATE INDEX audit_merchant_time_idx ON audit_logs(merchant_id, created_at DESC);

INSERT INTO schema_migrations(version) VALUES ('0001_initial');
COMMIT;
