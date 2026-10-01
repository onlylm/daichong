// Credentials arrive through stdin, never through command arguments or output.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {loadConfig} from "../dist/config.js";
import {createRuntime} from "../dist/bootstrap.js";

const config = loadConfig();
assert.equal(config.paymentProvider, "mock");
assert.equal(config.fulfillmentProvider, "mock");
assert.equal(config.liveTest.enabled, false);
assert.equal(config.enableSandboxRoutes, false);
assert.equal(config.zovocardApiKey, null);
const runtime = createRuntime(config);
try {
  assert.deepEqual(runtime.paymentSettings.available(), []);
  assert.equal(runtime.repository.listOperations("payment_revision").length, 0);
  const demoB = runtime.repository.findCredential("pt_demo_b", "key_demo_b_01");
  assert.equal(demoB.key.status, "revoked");
  assert.equal(demoB.merchant.status, "suspended");
} finally {runtime.close();}
const base = "http://127.0.0.1:3200";
const get = path => fetch(base + path, {signal: AbortSignal.timeout(10000)});
assert.equal((await get("/health/ready")).status, 200);
assert.equal((await get("/workspace")).status, 200);
assert.equal((await get("/workspace/api/payment-settings")).status, 401);
assert.equal((await get("/usdt-payments/prelaunch-check")).status, 404);
assert.equal((await fetch(base + "/sandbox/orders/test/pay", {method: "POST"})).status, 404);
const access = JSON.parse(readFileSync(0, "utf8"));
const login = await fetch(base + "/workspace/api/auth/login", {
  method: "POST", headers: {"content-type": "application/json", origin: config.publicBaseUrl},
  body: JSON.stringify({username: access.username, password: access.password}),
});
assert.equal(login.status, 200);
const session = await login.json();
assert.equal(session.data.role, "platform_admin");
assert.equal(session.data.mustChangePassword, true);
const cookieHeader = login.headers.get("set-cookie");
assert.ok(cookieHeader.includes("HttpOnly"));
assert.ok(cookieHeader.includes("SameSite=Strict"));
const cookie = cookieHeader.split(";")[0];
assert.equal((await fetch(base + "/workspace/api/auth/me", {headers: {cookie}})).status, 200);
assert.equal((await fetch(base + "/workspace/api/accounts", {headers: {cookie}})).status, 403);
assert.equal((await fetch(base + "/workspace/api/auth/logout", {
  method: "POST", headers: {cookie, origin: config.publicBaseUrl, "x-csrf-token": session.csrf},
})).status, 200);
console.log("PASS: health, workspace, admin login/logout, first-password-change gate, persistence configuration, no live payment, no USDT routes, no default demo credential.");
