BEGIN;

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.merchant_id', true), '')::uuid
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'merchant_roles', 'merchant_users', 'partner_apps', 'api_keys', 'merchant_product_grants', 'merchant_price_rules',
    'orders', 'payment_attempts', 'fulfillment_attempts', 'sensitive_payloads',
    'refunds', 'ledger_transactions', 'ledger_entries', 'settlements',
    'settlement_lines', 'invoices', 'webhook_endpoints', 'outbox_events', 'webhook_deliveries',
    'idempotency_records', 'state_transitions', 'audit_logs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (merchant_id = current_tenant_id()) WITH CHECK (merchant_id = current_tenant_id())',
      table_name
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION reject_immutable_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END $$;

CREATE TRIGGER ledger_transactions_no_update_delete
BEFORE UPDATE OR DELETE ON ledger_transactions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE TRIGGER ledger_entries_no_update_delete
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE TRIGGER state_transitions_no_update_delete
BEFORE UPDATE OR DELETE ON state_transitions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE TRIGGER audit_logs_no_update_delete
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE OR REPLACE FUNCTION assert_ledger_transaction_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_transaction uuid;
  debit_total bigint;
  credit_total bigint;
BEGIN
  target_transaction := COALESCE(NEW.transaction_id, OLD.transaction_id);
  SELECT
    COALESCE(sum(amount_minor) FILTER (WHERE direction = 'debit'), 0),
    COALESCE(sum(amount_minor) FILTER (WHERE direction = 'credit'), 0)
  INTO debit_total, credit_total
  FROM ledger_entries
  WHERE transaction_id = target_transaction;
  IF debit_total <> credit_total THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced: debit %, credit %', target_transaction, debit_total, credit_total
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ledger_entries_must_balance
AFTER INSERT OR UPDATE OR DELETE ON ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_ledger_transaction_balanced();

CREATE OR REPLACE FUNCTION protect_sealed_settlement_line() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  settlement_state settlement_status;
BEGIN
  SELECT status INTO settlement_state FROM settlements WHERE id = COALESCE(OLD.settlement_id, NEW.settlement_id);
  IF settlement_state IN ('confirmed', 'paying', 'paid', 'failed') THEN
    RAISE EXCEPTION 'sealed settlement lines are immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER settlement_lines_protect_sealed
BEFORE UPDATE OR DELETE ON settlement_lines
FOR EACH ROW EXECUTE FUNCTION protect_sealed_settlement_line();

INSERT INTO schema_migrations(version) VALUES ('0002_rls_and_immutability');
COMMIT;
