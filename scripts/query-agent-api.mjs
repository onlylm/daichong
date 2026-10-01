import {DatabaseSync} from "node:sqlite";
const partnerId = process.argv[2];
if (!partnerId) {
  console.error("usage: node query-agent-api.mjs <partnerId>");
  process.exit(1);
}
const db = new DatabaseSync(process.env.SQLITE_PATH || "/app/data/production.sqlite");
const merchant = db.prepare("SELECT id, payload FROM sandbox_records WHERE kind='merchant' AND payload LIKE ?").get(`%${partnerId}%`);
if (!merchant) {
  console.error("merchant not found");
  process.exit(1);
}
const merchantId = merchant.id;
const payload = JSON.parse(merchant.payload);
console.log("merchant:", {id: merchantId, name: payload.name, partnerId: payload.partnerId, status: payload.status});
for (const kind of ["api_access", "account", "wallet_deposit"]) {
  const rows = db.prepare("SELECT id, payload FROM sandbox_records WHERE kind=? AND (id=? OR payload LIKE ?)").all("ops_" + kind, merchantId, `%${merchantId}%`);
  for (const row of rows) {
    const p = JSON.parse(row.payload);
    if (kind === "account") console.log("account:", {id: row.id, username: p.username, role: p.role, status: p.status});
    else console.log(kind + ":", p);
  }
}
const apps = db.prepare("SELECT id, payload FROM sandbox_records WHERE kind='partner_app' AND merchant_id=?").all(merchantId);
for (const row of apps) {
  const p = JSON.parse(row.payload);
  if (p.appId !== "quefa_web_portal") console.log("app:", {appId: p.appId, name: p.name, status: p.status});
}
const keys = db.prepare("SELECT id, payload FROM sandbox_records WHERE kind='api_key' AND merchant_id=?").all(merchantId);
for (const row of keys) console.log("api_key:", JSON.parse(row.payload).keyId, JSON.parse(row.payload).status);
const balance = db.prepare("SELECT SUM(CAST(json_extract(payload,'$.procurementDelta') AS INTEGER)) AS b FROM sandbox_records WHERE kind='ops_wallet_entry' AND merchant_id=?").get(merchantId);
console.log("procurement_balance_minor:", balance?.b ?? 0);
