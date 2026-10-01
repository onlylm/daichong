// Read-only upstream diagnostic. Never prints credentials, cards, or order payloads.
import {DatabaseSync} from 'node:sqlite';
const {loadConfig}=await import(process.cwd()+'/dist/config.js');
const {SensitivePayloadCipher}=await import(process.cwd()+'/dist/infra/crypto.js');
const config=loadConfig();
const db=new DatabaseSync(config.sqlitePath,{readOnly:true});
db.exec('PRAGMA query_only=ON');
const value=db.prepare("SELECT payload FROM sandbox_records WHERE kind='supplier_connection' AND id='supplier_primary'").get();
const connection=JSON.parse(value.payload);
const secrets=new SensitivePayloadCipher(config.dataEncryptionKey,config.keyEncryptionKeyId).decrypt(connection.secretPayload,'supplier-connection:'+connection.id);
db.close();
const response=await fetch(connection.openApiBase+'/gpt-direct/plans?product=gpt',{headers:{'X-API-Key':secrets.apiKey},signal:AbortSignal.timeout(15000)});
const payload=await response.json();
if(!response.ok||payload.code!==0)throw new Error('upstream_quote_read_failed');
const data=payload.data;
const clean=v=>Object.fromEntries(Object.entries(v??{}).filter(([k,v])=>!/token|secret|key|account|email|card|credential/i.test(k)&&(v===null||['number','string','boolean'].includes(typeof v))));
console.log(JSON.stringify({dataFields:Object.keys(data),version:data.version,plans:Object.fromEntries(['plus','pro_5x','pro_20x','pro_50x'].map(k=>[k,clean(data.plans?.[k])])),registry:(data.registry??[]).filter(v=>['plus','pro_5x','pro_20x','pro_50x'].includes(v.key)).map(clean),regionFields:JSON.stringify(data.payment_regions??{}),pricingFields:clean(data.pricing??data.exchange_rates??data.fx_rates??{})}));
