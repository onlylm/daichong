import {afterEach, beforeEach, describe, expect, it,vi} from "vitest";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import type {Actor, WalletEntry} from "../src/operations/model.js";
import {managedGptProducts} from "../src/modules/gpt-products.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";
import type {Repository} from "../src/infra/repository.js";

const admin: Actor = {id: "policy-admin", role: "platform_admin", merchantId: null};

describe("2026-10-01 agent policy", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = createRuntime(loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"}));
    publishTestRechargeProduct(runtime);
  });
  afterEach(() => runtime.close());

  it("keeps exactly four current products with the configured supply and internal costs", () => {
    expect(managedGptProducts.map(product => [product.productCode, product.supplyPriceMinor, product.costPriceMinor])).toEqual([
      ["chatgpt_plus_cdk_1m", 11_000n, 10_800n],
      ["chatgpt_pro_5x_cdk_1m", 63_800n, 63_000n],
      ["chatgpt_pro_20x_cdk_1m", 100_000n, 96_100n],
      ["chatgpt_pro_50x_cdk_1m", 320_000n, 312_000n],
    ]);
    const merchant = runtime.repository.findMerchantByPartner("pt_demo_a")!;
    expect(runtime.repository.listProductGrants(merchant.id).filter(item => item.available).map(item => item.productCode).sort())
      .toEqual(managedGptProducts.map(item => item.productCode).sort());
    expect(() => runtime.catalog.requireGrant(merchant.id, "chatgpt_plus_1m")).toThrow("不在平台四款订阅套餐范围内");
  });

  it("opens API by default, permits a Chinese display name, and preserves the fixed partner id", () => {
    const created = runtime.agents.create(admin, {partnerId: "stable_partner", name: "Original Name"});
    const merchantId = created.merchant.id;
    expect(runtime.repository.getOperations("api_access", merchantId)).toMatchObject({enabled: true, depositId: "default:open-api"});
    const owner: Actor = {id: "owner", role: "agent_owner", merchantId};
    expect(runtime.apiAccess.summary(owner, merchantId)).toMatchObject({automaticAccess: true, canApply: false, apiDepositMinor: "0"});
    expect(() => runtime.apiAccess.apply(owner, merchantId, "无需申请", "retired-flow")).toThrow("无需申请或预存");
    runtime.agents.rename(owner, merchantId, {name: "中文代理商名称"});
    expect(runtime.repository.findMerchantById(merchantId)).toMatchObject({name: "中文代理商名称", partnerId: "stable_partner"});
  });

  it("forces platform collection at zero balance and unlocks agent collection only after real wallet credit", async () => {
    const credential = runtime.repository.findCredential("pt_demo_a", "key_demo_a_01")!;
    const tenant = {merchantId: credential.merchant.id, partnerId: credential.merchant.partnerId,
      appId: credential.app.appId, keyId: credential.key.keyId};
    await expect(runtime.orders.create(tenant, {merchantOrderNo: "zero-agent-collect", productCode: "chatgpt_plus_cdk_1m",
      quantity: 1, saleAmount: "135.00", collectionMode: "agent_collect"})).rejects.toMatchObject({code: "collection_mode_denied"});
    const platformOrder = await runtime.orders.create(tenant, {merchantOrderNo: "zero-platform-collect", productCode: "chatgpt_plus_cdk_1m",
      quantity: 1, saleAmount: "135.00", collectionMode: "platform_collect"});
    expect(platformOrder.collectionMode).toBe("platform_collect");
  });

  it("generates an idempotent historical settlement without paying, then requires manual pay and reconciliation", async () => {
    const credential = runtime.repository.findCredential("pt_demo_a", "key_demo_a_01")!;
    const tenant = {merchantId: credential.merchant.id, partnerId: credential.merchant.partnerId,
      appId: credential.app.appId, keyId: credential.key.keyId};
    const created = await runtime.orders.create(tenant, {merchantOrderNo: "settlement-order", productCode: "chatgpt_plus_cdk_1m",
      quantity: 1, saleAmount: "135.00", collectionMode: "platform_collect"});
    const at = new Date("2026-09-30T12:00:00.000Z");
    runtime.repository.updateOrder({...created, paymentStatus: "paid", paymentProviderRef: "ali_settlement",
      paymentReceivedMinor: created.saleAmountMinor, paymentFeeMinor: 0n, paidAt: at, createdAt: at, updatedAt: at});
    const attempt = runtime.repository.findPaymentAttemptByOrder(created.merchantId, created.id)!;
    runtime.repository.updatePaymentAttempt({...attempt, status: "paid", providerRef: "ali_settlement",
      receivedMinor: created.saleAmountMinor, feeMinor: 0n, paidAt: at, createdAt: at, updatedAt: at});
    runtime.repository.insertFulfillment({id: "ful_settlement", merchantId: created.merchantId, orderId: created.id,
      attemptNo: 1, status: "succeeded", failureCode: null, message: null, accountEmailMasked: null,
      sessionPayload: {ciphertext: null, iv: null, authTag: null, keyVersion: "test", clearedAt: null}, mode: "cdk",
      voucherId: null, upstreamProvider: "zovocard", upstreamOrderId: "up_settlement", upstreamClientRequestId: "req_settlement",
      upstreamLookupToken: null, upstreamStatus: "completed", upstreamStage: "completed", upstreamQuoteMinor: 1576,
      upstreamCurrency: "USD", nextCheckAt: at, createdAt: at, finishedAt: at});
    runtime.repository.saveOperations("wallet_credit", {id: created.id, merchantId: created.merchantId,
      orderId: created.id, recognizedMinor: 2_500n, createdAt: at}, true);
    const earning: WalletEntry = {id: "earning:" + created.id, merchantId: created.merchantId, kind: "earning_release",
      procurementDelta: 0n, earningsDelta: 2_500n, frozenDelta: 0n, reference: created.id, actorId: "system", createdAt: at};
    runtime.repository.saveOperations("wallet_entry", earning, true);

    expect(runtime.dailySettlements.generate("2026-09-30")).toMatchObject({generated: true, count: 1});
    expect(runtime.dailySettlements.generate("2026-09-30")).toMatchObject({generated: false, count: 0});
    const statement = runtime.dailySettlements.list(admin).find(item => item.merchantId === created.merchantId)!;
    expect(statement).toMatchObject({status: "pending_payment", orderCount: 1, supplyAmount: "110.00",
      platformCost: "108.00", platformProfit: "2.00", standardGrossProfit: "2.00", agentEarnings: "25.00", payable: "25.00"});
    expect(statement.standardGrossProfitBasis).toContain("不代表实际净利润");
    expect(runtime.repository.listOperations("wallet_entry", created.merchantId).reduce((sum, item) => sum + item.earningsDelta, 0n)).toBe(2_500n);
    expect(() => runtime.dailySettlements.confirmPaid(admin, statement.id,
      {method: "alipay", reference: "202610010001", evidence: ""})).toThrow("付款凭证");
    const paid = runtime.dailySettlements.confirmPaid(admin, statement.id,
      {method: "alipay", reference: "202610010001", evidence: "支付宝账单截图已归档"});
    expect(paid.status).toBe("paid");
    expect(runtime.dailySettlements.confirmPaid(admin, statement.id,
      {method: "alipay", reference: "202610010001", evidence: "支付宝账单截图已归档"})).toMatchObject({id: statement.id, status: "paid"});
    expect(() => runtime.dailySettlements.confirmPaid(admin, statement.id,
      {method: "bank", reference: "202610010001", evidence: "另一份付款凭证"})).toThrow("重放内容与原付款记录不一致");
    expect(runtime.repository.listOperations("wallet_entry", created.merchantId).reduce((sum, item) => sum + item.earningsDelta, 0n)).toBe(0n);
    expect(runtime.dailySettlements.reconcile(admin, statement.id, "代理确认到账，金额流水一致").status).toBe("reconciled");
  });

  it.each(["suspended", "closed"] as const)("keeps %s agents' earned commission in manual daily settlement", async status => {
    for (const storageDriver of ["memory", "sqlite"] as const) {
      const isolated = createRuntime(loadConfig({NODE_ENV: "test", STORAGE_DRIVER: storageDriver,
        SQLITE_PATH: ":memory:", LOG_LEVEL: "silent"}));
      try {
        publishTestRechargeProduct(isolated);
        const order = await seedSettlementEarning(isolated, `inactive-${storageDriver}-${status}`);
        const merchant = isolated.repository.findMerchantById(order.merchantId)!;
        isolated.repository.saveMerchant({...merchant, status});

        expect(isolated.dailySettlements.generate("2026-09-30")).toMatchObject({generated: true, count: 1});
        const statement = isolated.repository.getOperations("daily_settlement", `ds_20260930_${merchant.id}`)!;
        expect(statement).toMatchObject({status: "pending_payment", orderIds: [order.id], agentEarningsMinor: 2_500n,
          payableMinor: 2_500n});
        const earningsBalance = () => isolated.repository.listOperations("wallet_entry", merchant.id)
          .reduce((sum, entry) => sum + entry.earningsDelta, 0n);
        expect(earningsBalance()).toBe(2_500n);
        expect(isolated.dailySettlements.confirmPaid(admin, statement.id, {method: "bank",
          reference: `inactive-${storageDriver}-${status}-payment`, evidence: "真实付款凭证已归档"}).status).toBe("paid");
        expect(earningsBalance()).toBe(0n);
      } finally {
        isolated.close();
      }
    }
  });

  it("blocks payout when a pending refund can still reduce released earnings", async () => {
    const order=await seedSettlementEarning(runtime,"pending-refund");
    runtime.dailySettlements.generate("2026-09-30");
    const statement=runtime.dailySettlements.list(admin).find(item=>item.merchantId===order.merchantId)!;
    runtime.repository.insertRefund({id:"ref_pending_settlement",merchantId:order.merchantId,orderId:order.id,
      merchantRefundNo:"pending-settlement-refund",type:"partial",amountMinor:1_000n,status:"requested",reason:"等待渠道确认",
      failureCode:null,createdAt:new Date(),refundedAt:null});
    expect(()=>runtime.dailySettlements.confirmPaid(admin,statement.id,
      {method:"alipay",reference:"202610010101",evidence:"支付宝付款凭证已归档"})).toThrow("退款待确认");
    expect(runtime.repository.getOperations("daily_settlement",statement.id)?.status).toBe("pending_payment");
    expect(runtime.repository.getOperations("wallet_entry","settlement_payout:"+statement.id)).toBeNull();
  });

  it("blocks payout while a statement order has an unresolved provider refund difference", async () => {
    const order=await seedSettlementEarning(runtime,"provider-refund-difference");
    runtime.dailySettlements.generate("2026-09-30");
    const statement=runtime.dailySettlements.list(admin).find(item=>item.merchantId===order.merchantId)!;
    runtime.repository.saveOperations("refund_reconciliation",{id:"refund-reconciliation:"+order.id,merchantId:order.merchantId,
      orderId:order.id,provider:"alipay_page",status:"reviewing",reportedMinor:1_000n,recordedMinor:0n,differenceMinor:1_000n,
      providerReferenceFingerprint:"settlement-provider-refund-difference",legacyTicketIds:[],version:1,
      firstDetectedAt:new Date(),lastCheckedAt:new Date(),resolvedAt:null},true);
    expect(()=>runtime.dailySettlements.confirmPaid(admin,statement.id,
      {method:"alipay",reference:"202610010151",evidence:"支付宝付款凭证已归档"})).toThrow("渠道退款差异");
    expect(runtime.repository.getOperations("daily_settlement",statement.id)?.status).toBe("pending_payment");
    expect(runtime.repository.getOperations("wallet_entry","settlement_payout:"+statement.id)).toBeNull();
  });

  it("does not let unrelated new earnings hide a stale settlement after commission reversal", async () => {
    const order=await seedSettlementEarning(runtime,"stale-commission");
    runtime.dailySettlements.generate("2026-09-30");
    const statement=runtime.dailySettlements.list(admin).find(item=>item.merchantId===order.merchantId)!;
    const credit=runtime.repository.getOperations("wallet_credit",order.id)!;
    runtime.repository.saveOperations("wallet_credit",{...credit,recognizedMinor:1_500n});
    runtime.repository.saveOperations("wallet_entry",{id:"earning_reversal:test",merchantId:order.merchantId,kind:"earning_reversal",
      procurementDelta:0n,earningsDelta:-1_000n,frozenDelta:0n,reference:order.id,actorId:"system",createdAt:new Date()},true);
    runtime.repository.saveOperations("wallet_entry",{id:"earning:later-order",merchantId:order.merchantId,kind:"earning_release",
      procurementDelta:0n,earningsDelta:2_000n,frozenDelta:0n,reference:"later-order",actorId:"system",createdAt:new Date()},true);
    expect(runtime.repository.listOperations("wallet_entry",order.merchantId)
      .reduce((sum,entry)=>sum+entry.earningsDelta,0n)).toBe(3_500n);
    expect(()=>runtime.dailySettlements.confirmPaid(admin,statement.id,
      {method:"bank",reference:"202610010102",evidence:"银行付款凭证已归档"})).toThrow("收益已因退款或纠偏变化");
    expect(runtime.repository.getOperations("daily_settlement",statement.id)?.status).toBe("pending_payment");
    expect(runtime.repository.getOperations("wallet_entry","settlement_payout:"+statement.id)).toBeNull();
  });

  it.each(["memory", "sqlite"] as const)("rejects %s payout when an unrelated balance masks a missing order earning entry", async storageDriver => {
    const isolated=createRuntime(loadConfig({NODE_ENV:"test",STORAGE_DRIVER:storageDriver,SQLITE_PATH:":memory:",LOG_LEVEL:"silent"}));
    try {
      publishTestRechargeProduct(isolated);
      const order=await seedSettlementEarning(isolated,`orphan-credit-${storageDriver}`,{skipWalletEntry:true});
      isolated.repository.saveOperations("wallet_entry",{id:`earning:unrelated-${storageDriver}`,merchantId:order.merchantId,
        kind:"earning_release",procurementDelta:0n,earningsDelta:2_500n,frozenDelta:0n,
        reference:`unrelated-${storageDriver}`,actorId:"system",createdAt:new Date()},true);
      isolated.dailySettlements.generate("2026-09-30");
      const statement=isolated.repository.getOperations("daily_settlement",`ds_20260930_${order.merchantId}`)!;
      expect(statement).toMatchObject({agentEarningsMinor:2_500n,payableMinor:2_500n,status:"pending_payment"});
      expect(()=>isolated.dailySettlements.confirmPaid(admin,statement.id,{method:"bank",
        reference:`orphan-credit-${storageDriver}-payment`,evidence:"银行付款凭证已归档"}))
        .toThrow("收益记录与资金流水不一致");
      expect(isolated.repository.getOperations("daily_settlement",statement.id)?.status).toBe("pending_payment");
      expect(isolated.repository.getOperations("wallet_entry","settlement_payout:"+statement.id)).toBeNull();
    } finally { isolated.close(); }
  });

  it.each(["memory", "sqlite"] as const)("rejects %s payout when credit changed without its reversal ledger", async storageDriver => {
    const isolated=createRuntime(loadConfig({NODE_ENV:"test",STORAGE_DRIVER:storageDriver,SQLITE_PATH:":memory:",LOG_LEVEL:"silent"}));
    try {
      publishTestRechargeProduct(isolated);
      const order=await seedSettlementEarning(isolated,`missing-reversal-${storageDriver}`);
      const credit=isolated.repository.getOperations("wallet_credit",order.id)!;
      isolated.repository.saveOperations("wallet_credit",{...credit,recognizedMinor:1_500n});
      isolated.dailySettlements.generate("2026-09-30");
      const statement=isolated.repository.getOperations("daily_settlement",`ds_20260930_${order.merchantId}`)!;
      expect(statement).toMatchObject({agentEarningsMinor:1_500n,payableMinor:1_500n,status:"pending_payment"});
      expect(()=>isolated.dailySettlements.confirmPaid(admin,statement.id,{method:"bank",
        reference:`missing-reversal-${storageDriver}-payment`,evidence:"银行付款凭证已归档"}))
        .toThrow("收益记录与资金流水不一致");
      expect(isolated.repository.getOperations("wallet_entry","settlement_payout:"+statement.id)).toBeNull();
    } finally { isolated.close(); }
  });

  it.each(["memory", "sqlite"] as const)("checks %s order earnings across a 400-id query boundary without mixing tenants", storageDriver => {
    const isolated=createRuntime(loadConfig({NODE_ENV:"test",STORAGE_DRIVER:storageDriver,SQLITE_PATH:":memory:",LOG_LEVEL:"silent"}));
    try {
      const merchantId=isolated.repository.findMerchantByPartner("pt_demo_a")!.id;
      const otherMerchantId=isolated.repository.findMerchantByPartner("pt_demo_b")!.id;
      const orderIds=Array.from({length:401},(_,index)=>`boundary-${index}`),orderId=orderIds[400]!;
      const at=new Date("2026-09-30T12:00:00.000Z");
      isolated.repository.saveOperations("wallet_credit",{id:"boundary-credit",merchantId,orderId,
        recognizedMinor:2_500n,createdAt:at},true);
      isolated.repository.saveOperations("wallet_entry",{id:"boundary-entry",merchantId,kind:"earning_release",
        procurementDelta:0n,earningsDelta:2_500n,frozenDelta:0n,reference:orderId,actorId:"system",createdAt:at},true);
      isolated.repository.saveOperations("wallet_credit",{id:"boundary-other-credit",merchantId:otherMerchantId,orderId,
        recognizedMinor:9_999n,createdAt:at},true);
      isolated.repository.saveOperations("wallet_entry",{id:"boundary-other-entry",merchantId:otherMerchantId,kind:"earning_release",
        procurementDelta:0n,earningsDelta:9_999n,frozenDelta:0n,reference:orderId,actorId:"system",createdAt:at},true);
      const rows=isolated.repository.settlementEarningRows(merchantId,orderIds);
      expect(rows).toHaveLength(401);
      expect(rows[0]).toEqual({orderId:"boundary-0",creditMinor:0n,creditCount:0,ledgerMinor:0n});
      expect(rows[400]).toEqual({orderId,creditMinor:2_500n,creditCount:1,ledgerMinor:2_500n});
    } finally { isolated.close(); }
  });

  it("builds SQLite settlement candidates and balances without per-order historical scans",async()=>{
    const sqlite=createRuntime(loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"sqlite",SQLITE_PATH:":memory:",LOG_LEVEL:"silent"}));
    try{
      publishTestRechargeProduct(sqlite);
      const credential=sqlite.repository.findCredential("pt_demo_a","key_demo_a_01")!,tenant={merchantId:credential.merchant.id,
        partnerId:credential.merchant.partnerId,appId:credential.app.appId,keyId:credential.key.keyId};
      const created=await sqlite.orders.create(tenant,{merchantOrderNo:"settlement-sqlite",productCode:"chatgpt_plus_cdk_1m",
        quantity:1,saleAmount:"135.00",collectionMode:"platform_collect"}),at=new Date("2026-09-30T12:00:00.000Z");
      sqlite.repository.updateOrder({...created,paymentStatus:"paid",paymentProviderRef:"ali_settlement_sqlite",paymentReceivedMinor:created.saleAmountMinor,
        paymentFeeMinor:0n,paidAt:at,createdAt:at,updatedAt:at});
      const attempt=sqlite.repository.findPaymentAttemptByOrder(created.merchantId,created.id)!;
      sqlite.repository.updatePaymentAttempt({...attempt,status:"paid",providerRef:"ali_settlement_sqlite",receivedMinor:created.saleAmountMinor,
        feeMinor:0n,paidAt:at,createdAt:at,updatedAt:at});
      sqlite.repository.insertFulfillment({id:"ful_settlement_sqlite",merchantId:created.merchantId,orderId:created.id,attemptNo:1,status:"succeeded",
        failureCode:null,message:null,accountEmailMasked:null,sessionPayload:{ciphertext:null,iv:null,authTag:null,keyVersion:"test",clearedAt:null},mode:"cdk",
        voucherId:null,upstreamProvider:"zovocard",upstreamOrderId:"up_settlement_sqlite",upstreamClientRequestId:"req_settlement_sqlite",
        upstreamLookupToken:null,upstreamStatus:"completed",upstreamStage:"completed",upstreamQuoteMinor:1576,upstreamCurrency:"USD",nextCheckAt:at,createdAt:at,finishedAt:at});
      sqlite.repository.saveOperations("wallet_credit",{id:created.id,merchantId:created.merchantId,orderId:created.id,recognizedMinor:2_500n,createdAt:at},true);
      sqlite.repository.saveOperations("wallet_entry",{id:"earning:"+created.id,merchantId:created.merchantId,kind:"earning_release",procurementDelta:0n,
        earningsDelta:2_500n,frozenDelta:0n,reference:created.id,actorId:"system",createdAt:at},true);
      const fullOperations=vi.spyOn(sqlite.repository,"listOperations"),orders=vi.spyOn(sqlite.repository,"findOrderInternal"),
        payments=vi.spyOn(sqlite.repository,"findPaymentAttemptByOrder"),fulfillments=vi.spyOn(sqlite.repository,"listFulfillments");
      expect(sqlite.dailySettlements.generate("2026-09-30")).toMatchObject({generated:true,count:1});
      const statement=sqlite.repository.getOperations("daily_settlement",`ds_20260930_${created.merchantId}`)!;
      expect(statement).toMatchObject({orderIds:[created.id],agentEarningsMinor:2_500n,payableMinor:2_500n,platformProfitMinor:200n});
      expect(fullOperations).not.toHaveBeenCalled();expect(orders).not.toHaveBeenCalled();expect(payments).not.toHaveBeenCalled();expect(fulfillments).not.toHaveBeenCalled();
      expect((sqlite.repository as Repository).listDailySettlementCandidates?.(new Date("2026-10-01T14:00:00.000Z"))).toEqual([]);
      const pendingRefund={id:"ref_settlement_sqlite",merchantId:created.merchantId,orderId:created.id,
        merchantRefundNo:"settlement-sqlite-pending",type:"partial" as const,amountMinor:100n,status:"requested" as const,
        reason:"等待渠道确认",failureCode:null,createdAt:new Date(),refundedAt:null};
      sqlite.repository.insertRefund(pendingRefund);
      expect(()=>sqlite.dailySettlements.confirmPaid(admin,String(statement.id),
        {method:"alipay",reference:"202610010201",evidence:"支付宝付款凭证已归档"})).toThrow("退款待确认");
      sqlite.repository.updateRefund({...pendingRefund,status:"cancelled"});
      const difference={id:"refund-reconciliation:"+created.id,merchantId:created.merchantId,orderId:created.id,
        provider:"alipay_page" as const,status:"reviewing" as const,reportedMinor:100n,recordedMinor:0n,differenceMinor:100n,
        providerReferenceFingerprint:"sqlite-provider-refund-difference",legacyTicketIds:[],version:1,
        firstDetectedAt:new Date(),lastCheckedAt:new Date(),resolvedAt:null};
      sqlite.repository.saveOperations("refund_reconciliation",difference,true);
      expect(()=>sqlite.dailySettlements.confirmPaid(admin,String(statement.id),
        {method:"alipay",reference:"202610010201",evidence:"支付宝付款凭证已归档"})).toThrow("渠道退款差异");
      sqlite.repository.saveOperations("refund_reconciliation",{...difference,status:"resolved",differenceMinor:0n,
        version:2,resolvedAt:new Date(),lastCheckedAt:new Date()});
      expect(sqlite.dailySettlements.confirmPaid(admin,String(statement.id),
        {method:"alipay",reference:"202610010201",evidence:"支付宝付款凭证已归档"})).toMatchObject({status:"paid"});
      expect(fullOperations).not.toHaveBeenCalled();expect(orders).not.toHaveBeenCalled();expect(payments).not.toHaveBeenCalled();expect(fulfillments).not.toHaveBeenCalled();
    }finally{vi.restoreAllMocks();sqlite.close();}
  });

  it("does not let an unrelated order refund block a SQLite settlement payout",async()=>{
    const sqlite=createRuntime(loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"sqlite",SQLITE_PATH:":memory:",LOG_LEVEL:"silent"}));
    try{
      publishTestRechargeProduct(sqlite);
      const included=await seedSettlementEarning(sqlite,"sqlite-included");
      sqlite.dailySettlements.generate("2026-09-30");
      const statement=sqlite.repository.getOperations("daily_settlement",`ds_20260930_${included.merchantId}`)!;
      const unrelated=await seedSettlementEarning(sqlite,"sqlite-unrelated");
      sqlite.repository.insertRefund({id:"ref_unrelated_settlement",merchantId:unrelated.merchantId,orderId:unrelated.id,
        merchantRefundNo:"unrelated-settlement-refund",type:"partial",amountMinor:100n,status:"requested",reason:"无关订单退款待确认",
        failureCode:null,createdAt:new Date(),refundedAt:null});
      sqlite.repository.saveOperations("refund_reconciliation",{id:"refund-reconciliation:"+unrelated.id,merchantId:unrelated.merchantId,
        orderId:unrelated.id,provider:"alipay_page",status:"reviewing",reportedMinor:100n,recordedMinor:0n,differenceMinor:100n,
        providerReferenceFingerprint:"unrelated-provider-refund-difference",legacyTicketIds:[],version:1,
        firstDetectedAt:new Date(),lastCheckedAt:new Date(),resolvedAt:null},true);
      expect(sqlite.dailySettlements.confirmPaid(admin,String(statement.id),
        {method:"bank",reference:"202610010301",evidence:"银行付款凭证已归档"})).toMatchObject({status:"paid"});
    }finally{sqlite.close();}
  });
});

async function seedSettlementEarning(runtime:Runtime,suffix:string,options:{skipWalletEntry?:boolean}={}){
  const credential=runtime.repository.findCredential("pt_demo_a","key_demo_a_01")!;
  const tenant={merchantId:credential.merchant.id,partnerId:credential.merchant.partnerId,
    appId:credential.app.appId,keyId:credential.key.keyId};
  const created=await runtime.orders.create(tenant,{merchantOrderNo:"settlement-"+suffix,productCode:"chatgpt_plus_cdk_1m",
    quantity:1,saleAmount:"135.00",collectionMode:"platform_collect"});
  const at=new Date("2026-09-30T12:00:00.000Z");
  runtime.repository.updateOrder({...created,paymentStatus:"paid",paymentProviderRef:"ali_"+suffix,
    paymentReceivedMinor:created.saleAmountMinor,paymentFeeMinor:0n,paidAt:at,createdAt:at,updatedAt:at});
  const attempt=runtime.repository.findPaymentAttemptByOrder(created.merchantId,created.id)!;
  runtime.repository.updatePaymentAttempt({...attempt,status:"paid",providerRef:"ali_"+suffix,
    receivedMinor:created.saleAmountMinor,feeMinor:0n,paidAt:at,createdAt:at,updatedAt:at});
  runtime.repository.insertFulfillment({id:"ful_"+suffix,merchantId:created.merchantId,orderId:created.id,attemptNo:1,status:"succeeded",
    failureCode:null,message:null,accountEmailMasked:null,sessionPayload:{ciphertext:null,iv:null,authTag:null,keyVersion:"test",clearedAt:null},mode:"cdk",
    voucherId:null,upstreamProvider:"zovocard",upstreamOrderId:"up_"+suffix,upstreamClientRequestId:"req_"+suffix,
    upstreamLookupToken:null,upstreamStatus:"completed",upstreamStage:"completed",upstreamQuoteMinor:1576,upstreamCurrency:"USD",
    nextCheckAt:at,createdAt:at,finishedAt:at});
  runtime.repository.saveOperations("wallet_credit",{id:created.id,merchantId:created.merchantId,
    orderId:created.id,recognizedMinor:2_500n,createdAt:at},true);
  if(!options.skipWalletEntry)runtime.repository.saveOperations("wallet_entry",{id:"earning:"+created.id,merchantId:created.merchantId,kind:"earning_release",
    procurementDelta:0n,earningsDelta:2_500n,frozenDelta:0n,reference:created.id,actorId:"system",createdAt:at},true);
  return created;
}
