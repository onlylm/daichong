import {describe,expect,it} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {alipayCheckoutPage} from "../src/modules/alipay-page.js";
import {AlipayPagePaymentProvider,AlipayPaymentService,type AlipayClient} from "../src/modules/alipay-payment.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

describe("Alipay checkout strict style CSP",()=>{
  it.each(["Quefa · 支付宝收银台","采购余额充值 · 支付宝","开票补差价 · 支付宝"])("renders %s without inline style attributes",title=>{
    const html=alipayCheckoutPage("synthetic-csp-nonce",title);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).toContain('<style nonce="synthetic-csp-nonce">');
    expect(html).toContain('<script nonce="synthetic-csp-nonce">');
    expect(html).toContain('class="eyebrow qr-heading"');
    expect(html).toContain('class="qr-help"');
    expect(html).toContain('.qr-heading{text-align:center}');
    expect(html).toContain('.qr-help{text-align:center;color:var(--muted);font-size:13px;line-height:1.7}');
  });

  it("keeps HTTP checkout styles under the response nonce without relaxing CSP",async()=>{
    const config=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"memory",LOG_LEVEL:"silent",PUBLIC_BASE_URL:"http://127.0.0.1:3305"});
    const runtime=createRuntime(config);
    publishTestRechargeProduct(runtime);
    const bundle=runtime.repository.findCredential(config.demoPartnerId,config.demoKeyId)!;
    const order=await runtime.orders.create({merchantId:bundle.merchant.id,partnerId:bundle.merchant.partnerId,appId:bundle.app.id,keyId:bundle.key.keyId},
      {merchantOrderNo:"synthetic-csp-checkout",productCode:"chatgpt_plus_cdk_1m",quantity:1,saleAmount:"135.00",deliveryMode:"auto_recharge"});
    const attempt=runtime.repository.findPaymentAttemptByOrder(order.merchantId,order.id)!;
    runtime.repository.updatePaymentAttempt({...attempt,provider:"alipay_page"});
    const client={exec:async()=>{throw new Error("external_network_forbidden");},pageExecute:()=>"",checkNotifySignV2:()=>false} as unknown as AlipayClient;
    const provider=new AlipayPagePaymentProvider(config.publicBaseUrl,runtime.portalTokens);
    runtime.alipay=new AlipayPaymentService(runtime.repository,runtime.payment,client,{appId:"synthetic",sellerId:"synthetic"},config.publicBaseUrl,provider);
    const app=await buildApp(config,runtime);
    try{
      const url=new URL(provider.url(order.id));
      const response=await app.inject({method:"GET",url:url.pathname+url.search});
      expect(response.statusCode).toBe(200);
      const csp=String(response.headers["content-security-policy"]);
      const nonce=/style-src 'nonce-([^']+)'/.exec(csp)?.[1];
      expect(nonce).toBeTruthy();
      expect(csp).not.toContain("unsafe-inline");
      expect(csp).toContain("default-src 'none'");
      expect(response.body).toContain(`<style nonce="${nonce}">`);
      expect(response.body).toContain(`<script nonce="${nonce}">`);
      expect(response.body).not.toMatch(/\sstyle\s*=/i);
    }finally{await app.close();runtime.close();}
  });
});
