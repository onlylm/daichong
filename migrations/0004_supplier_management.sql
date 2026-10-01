BEGIN;

-- Quefa 平台内部充值供应连接。该表不是租户资源，不允许代理商数据库角色访问。
-- API Key、回调密钥和直充内部支付资源只允许以一个 AES-GCM 密文载荷保存。
CREATE TABLE platform_supplier_connections (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  provider text NOT NULL CHECK (provider IN ('zovocard')),
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  open_api_base text NOT NULL CHECK (open_api_base ~ '^https://'),
  cdk_base text NOT NULL CHECK (cdk_base ~ '^https://'),
  enabled boolean NOT NULL DEFAULT false,
  secret_ciphertext bytea NOT NULL,
  secret_iv bytea NOT NULL,
  secret_auth_tag bytea NOT NULL,
  key_version text NOT NULL,
  config_version integer NOT NULL DEFAULT 1 CHECK (config_version > 0),
  last_test_status text NOT NULL DEFAULT 'never'
    CHECK (last_test_status IN ('never', 'succeeded', 'failed')),
  last_test_message text,
  last_test_at timestamptz,
  last_plan_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX platform_supplier_connections_one_enabled_idx
  ON platform_supplier_connections((true)) WHERE enabled;

-- 上游套餐只保存可售状态和价格快照，不保存任何用户凭据或支付资源资料。
CREATE TABLE supplier_plan_snapshots (
  connection_id text NOT NULL REFERENCES platform_supplier_connections(id),
  product text NOT NULL CHECK (product IN ('gpt', 'claude', 'grok')),
  plan text NOT NULL,
  acc_plan_key text NOT NULL,
  name text NOT NULL,
  enabled boolean NOT NULL,
  purchasable boolean NOT NULL,
  service_fee_usd_minor integer CHECK (service_fee_usd_minor >= 0),
  pricing_version integer,
  synced_at timestamptz NOT NULL,
  PRIMARY KEY (connection_id, product, plan)
);

-- Quefa 对外商品到充值套餐的内部映射。代理商只会看到 Quefa 商品信息。
CREATE TABLE supplier_product_mappings (
  product_code text PRIMARY KEY REFERENCES products(product_code),
  connection_id text NOT NULL REFERENCES platform_supplier_connections(id),
  fulfillment_mode text NOT NULL CHECK (fulfillment_mode IN ('direct', 'cdk')),
  supplier_product text NOT NULL CHECK (supplier_product IN ('gpt', 'claude', 'grok')),
  supplier_plan text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (fulfillment_mode <> 'cdk' OR supplier_product = 'gpt')
);

CREATE INDEX supplier_plan_snapshots_sellable_idx
  ON supplier_plan_snapshots(connection_id, product, enabled, purchasable, plan);
CREATE INDEX supplier_product_mappings_connection_idx
  ON supplier_product_mappings(connection_id, enabled, product_code);

REVOKE ALL ON platform_supplier_connections FROM PUBLIC;
REVOKE ALL ON supplier_plan_snapshots FROM PUBLIC;
REVOKE ALL ON supplier_product_mappings FROM PUBLIC;

INSERT INTO schema_migrations(version) VALUES ('0004_supplier_management');
COMMIT;
