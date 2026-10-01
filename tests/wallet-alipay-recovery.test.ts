import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {createRuntime,type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {WalletAlipayService} from "../src/modules/wallet-alipay.js";
import type {AlipayClient} from "../src/modules/alipay-payment.js";
import type {WalletDeposit} from "../src/operations/model.js";

describe("wallet Alipay timeout recovery",()=>{
  let runtime:Runtime,merchantId:string;
  const identity={appId:"2026000000000000",sellerId:"2088000000000000"};
  beforeEach(()=>{runtime=createRuntime(loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"memory",LOG_LEVEL:"silent"}));
    merchantId=runtime.repository.findMerchantByPartner("pt_demo_a")!.id;});
  afterEach(()=>{vi.restoreAllMocks();runtime.close();});

  function gateway(exec=vi.fn()){
    const client={exec,pageExecute:vi.fn(async()=>""),checkNotifySignV2:vi.fn(()=>true)} as unknown as AlipayClient;
    return {service:new WalletAlipayService(runtime.repository,runtime.paymentSettings,runtime.wallets,
      "https://pay.example.com",runtime.portalTokens,{client,identity}),exec};
  }
  function save(id:string,input:Partial<WalletDeposit>={}){
    const now=new Date(),value:WalletDeposit={id,merchantId,amountMinor:11_000n,status:"requested",requestKey:id,
      payerReference:"支付宝在线充值",verifiedReference:null,reviewerId:null,paymentProvider:"alipay_page",paymentConfigId:"pc_test",
      providerRef:id,expiresAt:new Date(now.getTime()-1_000),paidAt:null,nextCheckAt:null,createdAt:now,updatedAt:now,...input};
    runtime.repository.saveOperations("wallet_deposit",value,true);return value;
  }

  it("expires an unstarted deposit without a provider request and credits one verified late payment",async()=>{
    const deposit=save("wdep_expired_late"),{service,exec}=gateway();
    await service.reconcile(deposit.id);
    expect(exec).not.toHaveBeenCalled();
    expect(runtime.repository.getOperations("wallet_deposit",deposit.id)?.status).toBe("expired");
    const notice={out_trade_no:deposit.id,total_amount:"110.00",trade_no:"2026100100001881",trade_status:"TRADE_SUCCESS",
      sign_type:"RSA2",sign:"verified",app_id:identity.appId,seller_id:identity.sellerId};
    service.handleNotification(notice);service.handleNotification(notice);
    expect(runtime.repository.getOperations("wallet_deposit",deposit.id)).toMatchObject({status:"credited",verifiedReference:"2026100100001881"});
    const entries=runtime.repository.listOperations("wallet_entry",merchantId).filter(entry=>entry.reference==="2026100100001881");
    expect(entries).toHaveLength(1);expect(entries[0]?.procurementDelta).toBe(11_000n);
  });

  it("records a provider-closed deposit without a trade number and rejects a conflicting late success",()=>{
    const deposit=save("wdep_provider_closed",{providerRef:"https://qr.alipay.com/wallet-closed",expiresAt:new Date(Date.now()+60_000)}),
      {service}=gateway();
    service.handleNotification({out_trade_no:deposit.id,total_amount:"110.00",trade_status:"TRADE_CLOSED",
      sign_type:"RSA2",sign:"verified",app_id:identity.appId,seller_id:identity.sellerId});
    expect(runtime.repository.getOperations("wallet_deposit",deposit.id)?.status).toBe("closed");
    expect(()=>service.handleNotification({out_trade_no:deposit.id,total_amount:"110.00",trade_no:"2026100100001882",
      trade_status:"TRADE_SUCCESS",sign_type:"RSA2",sign:"verified",app_id:identity.appId,seller_id:identity.sellerId})).toThrow("已终结");
    expect(runtime.repository.listOperations("wallet_entry",merchantId)).toHaveLength(0);
  });

  it("does not let a stale closed result overwrite an interleaved wallet credit",()=>{
    const deposit=save("wdep_close_interleave",{providerRef:"https://qr.alipay.com/wallet-race",expiresAt:new Date(Date.now()+60_000)}),
      {service}=gateway(),repository=runtime.repository,transaction=repository.transaction.bind(repository);
    let injected=false;
    const transactionSpy=vi.spyOn(repository,"transaction").mockImplementation(action=>{
      if(!injected){injected=true;runtime.wallets.creditAlipayDeposit(deposit.id,"2026100100001883",deposit.amountMinor);}
      return transaction(action);
    });
    service.handleNotification({out_trade_no:deposit.id,total_amount:"110.00",trade_status:"TRADE_CLOSED",
      sign_type:"RSA2",sign:"verified",app_id:identity.appId,seller_id:identity.sellerId});
    transactionSpy.mockRestore();
    expect(runtime.repository.getOperations("wallet_deposit",deposit.id)?.status).toBe("credited");
    expect(runtime.repository.listOperations("wallet_entry",merchantId).filter(entry=>entry.reference==="2026100100001883")).toHaveLength(1);
  });

  it("coalesces concurrent payment-code creation and rejects an active cross-process lease",async()=>{
    const active=save("wdep_precreate_once",{expiresAt:new Date(Date.now()+60_000)});
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),code="https://qr.alipay.com/wallet-once";
    const exec=vi.fn(async()=>{await gate;return {code:"10000",qr_code:code};}),{service}=gateway(exec);
    const first=service.precreate(active.id),second=service.precreate(active.id);await Promise.resolve();release();
    await expect(Promise.all([first,second])).resolves.toEqual([code,code]);expect(exec).toHaveBeenCalledTimes(1);
    expect(runtime.repository.getOperations("wallet_deposit",active.id)).toMatchObject({providerRef:code,
      precreateLeaseToken:null,precreateLeaseUntil:null});

    const leased=save("wdep_precreate_leased",{expiresAt:new Date(Date.now()+60_000),precreateLeaseToken:"other-worker",
      precreateLeaseUntil:new Date(Date.now()+30_000)}),blocked=gateway(vi.fn()).service;
    await expect(blocked.precreate(leased.id)).rejects.toMatchObject({code:"payment_code_generating",retryable:true});
  });

  it("releases a failed payment-code lease so the same deposit can retry",async()=>{
    const deposit=save("wdep_precreate_retry",{expiresAt:new Date(Date.now()+60_000)}),exec=vi.fn()
      .mockResolvedValueOnce({code:"40004",msg:"failed"}).mockResolvedValueOnce({code:"10000",qr_code:"https://qr.alipay.com/wallet-retry"}),
      {service}=gateway(exec);
    await expect(service.precreate(deposit.id)).rejects.toMatchObject({code:"payment_provider_unavailable"});
    expect(runtime.repository.getOperations("wallet_deposit",deposit.id)).toMatchObject({precreateLeaseToken:null,precreateLeaseUntil:null});
    await expect(service.precreate(deposit.id)).resolves.toBe("https://qr.alipay.com/wallet-retry");
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
