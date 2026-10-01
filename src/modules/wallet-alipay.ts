import {AppError} from "../domain/errors.js";
import {minorToMoney} from "../domain/money.js";
import type {Repository} from "../infra/repository.js";
import type {Actor, WalletDeposit} from "../operations/model.js";
import type {WalletService} from "../operations/wallet.js";
import {createAlipayClientFromKeys, type AlipayClient} from "./alipay-payment.js";
import type {PaymentSettingsService} from "./payment-settings.js";
import type {PortalTokenService} from "./portal-token.js";
import {queryRecords} from "../infra/record-query.js";

/** Platform-owned Alipay checkout for an agent's procurement wallet. */
export class WalletAlipayService {
  constructor(
    private readonly repository: Repository,
    private readonly settings: PaymentSettingsService,
    private readonly wallets: WalletService,
    private readonly base: string,
    private readonly tokens: PortalTokenService,
    private readonly clientOverride: {client: AlipayClient; identity: {appId: string; sellerId: string}} | null = null,
  ) {}

  start(actor: Actor, merchantId: string, amount: string, requestKey: string): {deposit: WalletDeposit; payUrl: string} {
    const revision = this.settings.active("alipay_page");
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    const deposit = this.wallets.requestAlipayDeposit(actor, merchantId, amount, requestKey, revision.id, expiresAt);
    return {deposit, payUrl: this.portalUrl(deposit.id)};
  }

  portalUrl(id: string): string {
    return `${this.base}/wallet-payments/${encodeURIComponent(id)}?token=${this.tokens.paymentToken(id)}`;
  }

  resultUrl(id: string): string {
    return `${this.base}/wallet-payments/${encodeURIComponent(id)}/result?token=${this.tokens.paymentToken(id)}`;
  }

  async precreate(id: string): Promise<string> {
    this.settings.assertOpen("alipay_page");
    const deposit = this.deposit(id);
    if (deposit.status !== "requested" || !deposit.expiresAt || deposit.expiresAt <= new Date()) {
      throw new AppError(409, "payment_not_available", "余额充值订单不可支付，请返回钱包重新发起");
    }
    if (deposit.providerRef && isAlipayPrecreateQr(deposit.providerRef)) return deposit.providerRef;
    const {client, identity} = this.client(deposit);
    const result = await client.exec("alipay.trade.precreate", {
      notifyUrl: this.base + "/internal/webhooks/alipay",
      bizContent: {out_trade_no: deposit.id, product_code: "FACE_TO_FACE_PAYMENT", seller_id: identity.sellerId,
        total_amount: minorToMoney(deposit.amountMinor), subject: deposit.id, timeout_express: timeoutExpress(deposit.expiresAt)},
    }, {validateSign: true});
    const qrCode = typeof result.qr_code === "string" ? result.qr_code : "";
    if (result.code !== "10000" || !qrCode) throw new AppError(503, "payment_provider_unavailable", "支付宝当面付暂不可用，请稍后重试");
    this.repository.saveOperations("wallet_deposit", {...deposit, providerRef: qrCode, updatedAt: new Date()});
    return qrCode;
  }

  handleNotification(input: Record<string, string>): void {
    const deposit = this.deposit(input.out_trade_no ?? "");
    const {client, identity} = this.client(deposit);
    let valid = false;
    try { valid = input.sign_type === "RSA2" && client.checkNotifySignV2(input); } catch { /* fail closed */ }
    if (!valid || input.app_id !== identity.appId || input.seller_id !== identity.sellerId) {
      throw new AppError(400, "invalid_payment_notification", "支付通知验证失败");
    }
    this.accept(deposit, identity, input);
  }

  async reconcile(id: string): Promise<void> {
    const deposit = this.repository.transaction(() => {
      const current = this.deposit(id);
      if (current.status !== "requested" || (current.nextCheckAt && current.nextCheckAt > new Date())) return null;
      if(current.expiresAt&&current.expiresAt<=new Date()&&!isAlipayPrecreateQr(current.providerRef??"")){
        this.repository.saveOperations("wallet_deposit",{...current,status:"expired",nextCheckAt:null,updatedAt:new Date()});
        return null;
      }
      this.repository.saveOperations("wallet_deposit", {...current, nextCheckAt: new Date(Date.now() + 60_000), updatedAt: new Date()});
      return current;
    });
    if (!deposit) return;
    const {client, identity} = this.client(deposit);
    try {
      const result = await client.exec("alipay.trade.query", {bizContent: {out_trade_no: deposit.id}}, {validateSign: true});
      if (result.code === "40004" && result.sub_code === "ACQ.TRADE_NOT_EXIST") {
        if(deposit.expiresAt&&deposit.expiresAt<=new Date())this.finishUnpaid(deposit.id,"expired");
        return;
      }
      if (result.code !== "10000") throw new Error("query_failed");
      this.accept(deposit, identity, result as Record<string, string>);
    } catch {
      throw new AppError(503, "payment_query_pending", "支付宝结果暂未确认，请稍后查询；不要重复付款", true);
    }
  }

  async reconcileOne(): Promise<void> {
    const candidate = queryRecords(this.repository,"wallet_deposit",{filters:[{field:"paymentProvider",value:"alipay_page"},{field:"status",value:"requested"},
      {field:"nextCheckAt",op:"lte_or_null",value:new Date()}],orderBy:"nextCheckAt",direction:"asc",limit:1,count:false}).data[0];
    if (candidate) await this.reconcile(candidate.id);
  }

  private deposit(id: string): WalletDeposit {
    const value = this.repository.getOperations("wallet_deposit", id);
    if (!value || value.paymentProvider !== "alipay_page" || !value.paymentConfigId) {
      throw new AppError(404, "wallet_payment_not_found", "余额充值订单不存在");
    }
    return value;
  }

  private client(deposit: WalletDeposit): {client: AlipayClient; identity: {appId: string; sellerId: string}} {
    if(this.clientOverride)return this.clientOverride;
    const revision = this.settings.revision(deposit.paymentConfigId!, "alipay_page");
    const keys = this.settings.secrets(revision);
    const identity = {appId: revision.details.appId!, sellerId: revision.details.sellerId!};
    return {identity, client: createAlipayClientFromKeys({...identity, privateKey: keys.privateKey!,
      alipayPublicKey: keys.publicKey!, keyType: revision.details.keyType as "PKCS1" | "PKCS8"})};
  }

  private accept(deposit: WalletDeposit, identity: {appId: string; sellerId: string}, data: Record<string, string>): void {
    const success=["TRADE_SUCCESS","TRADE_FINISHED"].includes(data.trade_status??"");
    if (data.out_trade_no !== deposit.id || amountMinor(data.total_amount) !== deposit.amountMinor || (success&&!/^\d{8,64}$/.test(data.trade_no ?? ""))
        || (data.seller_id !== undefined && data.seller_id !== identity.sellerId)
        || (data.app_id !== undefined && data.app_id !== identity.appId)) {
      throw new AppError(409, "payment_binding_mismatch", "支付宝交易与余额充值订单不匹配");
    }
    if (success) {
      this.wallets.creditAlipayDeposit(deposit.id, data.trade_no!, deposit.amountMinor);
    }else if(data.trade_status==="TRADE_CLOSED")this.finishUnpaid(deposit.id,"closed");
  }

  private finishUnpaid(id:string,status:"expired"|"closed"):WalletDeposit {
    return this.repository.transaction(()=>{
      const current=this.deposit(id);
      if(current.status!=="requested")return current;
      const updated={...current,status,nextCheckAt:null,updatedAt:new Date()};
      this.repository.saveOperations("wallet_deposit",updated);
      return updated;
    });
  }
}

function amountMinor(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,12})(\.\d{1,2})?$/.test(value)) return -1n;
  const [integer = "0", fraction = ""] = value.split(".");
  return BigInt(integer) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function timeoutExpress(expiresAt: Date): string {
  return Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 60_000)) + "m";
}

function isAlipayPrecreateQr(value: string): boolean {
  try { return new URL(value).hostname === "qr.alipay.com"; } catch { return false; }
}
