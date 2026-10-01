export interface TradeCostCandidate {reference:string;usdMinor:number;state:"settled"|"completed_projection";matchedBy:"order_id"|"card_amount_window"}
export interface UpstreamCostFacts {amountMinor:number|null;currency:string|null;candidates:TradeCostCandidate[];matchIssue:string|null}
type Row=Record<string,unknown>;
const row=(v:unknown):Row=>v&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};
/** Card API's legacy auth_time is Asia/Shanghai; RFC3339 keeps its own offset. */
function time(v:unknown):number {if(typeof v!=="string")return NaN;return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)?v.replace(" ","T")+"+08:00":v);}
function cents(v:unknown):number|null {if(typeof v!=="number"||!Number.isFinite(v)||v<0)return null;const n=Math.round(v*100);return Number.isSafeInteger(n)&&Math.abs(v*100-n)<0.000001?n:null;}
/** No proximity-only match: require order/card provenance, native currency/amount, bounded order interval and one unique authorization. */
export function matchOrderTrades(order:Row,values:unknown[]):TradeCostCandidate[] {
  const id=String(order.order_id??order.id??""),start=time(order.created_at),end=time(order.completed_at);
  const native=typeof order.final_amount_minor==="number"?order.final_amount_minor:null,currency=order.currency;
  const candidates=new Map<string,TradeCostCandidate>();
  for(const value of values){const t=row(value),usd=cents(t.settle_amount),ref=typeof t.auth_id==="string"?t.auth_id:"";
    if(!ref||usd===null||usd<=0||t.settle_currency!=="USD"||t.status!=="COMPLETE"||!String(t.merchant_name??"").toUpperCase().includes("OPENAI")||!["Settlement","Authorization"].includes(String(t.type)))continue;
    const bound=t.order_id!=null&&String(t.order_id)===id;
    const authTime=time(t.auth_time),byWindow=t.order_id==null&&order.status==="completed"&&Number.isFinite(start)&&Number.isFinite(end)&&end>=start&&end-start<30*60_000&&authTime>=start&&authTime<=end+1000&&native!==null&&native>0&&cents(t.auth_amount)===native&&t.auth_currency===currency;
    if(!bound&&!byWindow)continue;
    const next:TradeCostCandidate={reference:ref,usdMinor:usd,state:t.type==="Settlement"?"settled":"completed_projection",matchedBy:bound?"order_id":"card_amount_window"};
    const old=candidates.get(ref);if(old&&old.usdMinor!==usd)return [];
    if(!old||next.state==="settled")candidates.set(ref,next);
  }
  return [...candidates.values()];
}
