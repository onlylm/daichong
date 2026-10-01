import {DatabaseSync} from "node:sqlite";
if(process.env.AUDIT_READ_ONLY!=="true")throw new Error("read_only_required");
const db=new DatabaseSync(process.env.SQLITE_PATH,{readOnly:true});
const partialIds=[["case_f88","8136"],["case_ec2","7df5"],["case_bd8","bbe7"],["case_c3f","0edd"],["case_b9c","4fe9"],["case_aad","7322"],["case_75a","e939"]];
try{
  db.exec("BEGIN");
  const result=partialIds.map(([prefix,suffix])=>{
    const matches=db.prepare("SELECT id,payload FROM sandbox_records WHERE kind='ops_ticket' AND id LIKE ? AND id LIKE ?").all(prefix+"%","%"+suffix);
    if(matches.length!==1)return {screenshotId:prefix+"…"+suffix,matches:matches.length};
    const ticket=JSON.parse(matches[0].payload);
    const o=db.prepare("SELECT payload FROM sandbox_records WHERE kind='order' AND id=?").get(ticket.orderId);
    const order=o?JSON.parse(o.payload):null;
    const m=db.prepare("SELECT payload FROM sandbox_records WHERE kind='merchant' AND id=?").get(ticket.merchantId);
    const merchant=m?JSON.parse(m.payload):null;
    const latest=db.prepare("SELECT payload FROM sandbox_records WHERE kind='fulfillment' AND merchant_id=? AND json_extract(payload,'$.orderId')=? ORDER BY CAST(json_extract(payload,'$.attemptNo') AS INTEGER) DESC LIMIT 1").get(ticket.merchantId,ticket.orderId);
    const task=latest?JSON.parse(latest.payload):null;
    const attempts=db.prepare("SELECT payload FROM sandbox_records WHERE kind='fulfillment' AND merchant_id=? AND json_extract(payload,'$.orderId')=? ORDER BY CAST(json_extract(payload,'$.attemptNo') AS INTEGER)").all(ticket.merchantId,ticket.orderId).map(r=>JSON.parse(r.payload));
    const voucherRecord=db.prepare("SELECT payload FROM sandbox_records WHERE kind='cdk_voucher' AND json_extract(payload,'$.orderId')=?").get(ticket.orderId);
    const voucher=voucherRecord?JSON.parse(voucherRecord.payload):null;
    const costRecord=db.prepare("SELECT payload FROM sandbox_records WHERE kind='ops_order_cost' AND id=?").get(ticket.orderId);
    const cost=costRecord?JSON.parse(costRecord.payload):null;
    const paymentRecord=db.prepare("SELECT payload FROM sandbox_records WHERE kind='payment_attempt' AND merchant_id=? AND json_extract(payload,'$.orderId')=?").get(ticket.merchantId,ticket.orderId);
    const payment=paymentRecord?JSON.parse(paymentRecord.payload):null;
    const amount=key=>order?.[key]?.__bigint??"0";
    return {screenshotId:prefix+"…"+suffix,ticketId:ticket.id,createdAt:ticket.createdAt,ticketStatus:ticket.status,
      agent:merchant?.name,partnerId:merchant?.partnerId,orderId:order?.id,merchantOrderNo:order?.merchantOrderNo,
      product:order?.productCode,createdOrderAt:order?.createdAt,payment:order?.paymentStatus,collectionMode:order?.collectionMode,
      saleMinor:amount("saleAmountMinor"),ordinaryRefundMinor:amount("ordinaryRefundedMinor"),priceAdjustmentMinor:amount("priceAdjustmentRefundedMinor"),
      liveTest:!!order?.liveTest,fulfillment:task?.status??null,failure:task?.failureCode??null,upstreamSubmitted:!!task?.upstreamOrderId,
      attempts:attempts.map(a=>({status:a.status,failure:a.failureCode,upstreamProvider:a.upstreamProvider,upstreamOrderId:a.upstreamOrderId,
        upstreamStatus:a.upstreamStatus,upstreamStage:a.upstreamStage,upstreamChargedMinor:a.upstreamChargedMinor??null,
        upstreamCurrency:a.upstreamCurrency,createdAt:a.createdAt,finishedAt:a.finishedAt,hasSubmissionMarker:a.upstreamStatus==="submission_pending",retryAllowed:a.retryAllowed??null})),
      successAttempts:attempts.filter(a=>a.status==="succeeded").length,
      voucher:voucher?{status:voucher.status,upstreamCdkId:voucher.upstreamCdkId,consumedAt:voucher.consumedAt}:null,
      cost:cost?{status:cost.status,actualUsdMinor:cost.actualUsdMinor?.__bigint??null,upstreamOrderId:cost.upstreamOrderId}:null,
      paymentEvidence:payment?{provider:payment.provider,status:payment.status,receivedMinor:payment.receivedMinor?.__bigint??null,hasProviderRef:!!payment.providerRef}:null,
      ledgerRecords:db.prepare("SELECT COUNT(*) n FROM sandbox_records WHERE kind='ledger' AND json_extract(payload,'$.orderId')=?").get(ticket.orderId).n};
  });
  console.log(JSON.stringify(result));db.exec("ROLLBACK");
}finally{db.close();}
