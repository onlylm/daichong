import {describe, expect, it} from "vitest";
import {createRuntime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {formatPublicOrderNo, isPublicOrderNo, PUBLIC_ORDER_NO_PATTERN} from "../src/domain/public-order-no.js";
describe("public order numbers", () => {
  it("formats monotonic QF ids", () => {
    expect(formatPublicOrderNo(1n)).toBe("QF0000000001");
    expect(formatPublicOrderNo(9_999_999_999n)).toBe("QF9999999999");
    expect(PUBLIC_ORDER_NO_PATTERN.test("QF0000000001")).toBe(true);
    expect(isPublicOrderNo("ord_legacy")).toBe(false);
    expect(isPublicOrderNo("QF-AAAA-BBBB")).toBe(false);
  });

  it("assigns QF ids to new orders", async () => {
    const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"});
    const runtime = createRuntime(config);
    const bundle = runtime.repository.findCredential(config.demoPartnerId, config.demoKeyId)!;
    const tenant = {merchantId: bundle.merchant.id, partnerId: bundle.merchant.partnerId, appId: bundle.app.id, keyId: bundle.key.keyId};
    const first = await runtime.orders.create(tenant, {merchantOrderNo: "pub-1", productCode: "chatgpt_plus_cdk_1m", quantity: 1, saleAmount: "135.00"});
    const second = await runtime.orders.create(tenant, {merchantOrderNo: "pub-2", productCode: "chatgpt_plus_cdk_1m", quantity: 1, saleAmount: "135.00"});
    expect(first.id).toMatch(/^QF[0-9]{10}$/);
    expect(second.id).toMatch(/^QF[0-9]{10}$/);
    expect(BigInt(second.id.slice(2))).toBe(BigInt(first.id.slice(2)) + 1n);
    runtime.close();
  });
});
