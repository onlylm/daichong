import http from "node:http";
import {createHash, createHmac, randomBytes, randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";

export function createDemoServer(config) {
  const base = new URL(config.baseUrl), tasks = new Map(), requestIds = new Map();
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("invalid_base_url");
  if (base.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw new Error("https_required");
  const browserToken = randomBytes(32).toString("hex");
  let windowAt = Date.now(), count = 0;
  async function call(method, path, payload, key = "") {
    const rawBody = payload === undefined ? "" : JSON.stringify(payload), timestamp = String(Math.floor(Date.now()/1000)), nonce = randomUUID();
    // This example uses fixed API paths with no query parameters.
    const canonical = [method,path,"",timestamp,nonce,config.keyId,key,createHash("sha256").update(rawBody).digest("hex")].join("\n");
    const signature = createHmac("sha256",config.secret).update(canonical).digest("hex");
    const result = await fetch(new URL(path,base),{method,redirect:"error",signal:AbortSignal.timeout(15000),
      headers:{"x-partner-id":config.partnerId,"x-key-id":config.keyId,"x-timestamp":timestamp,"x-nonce":nonce,"x-signature":signature,
        ...(payload === undefined?{}:{"content-type":"application/json","idempotency-key":key})},
      ...(payload === undefined?{}:{body:rawBody})});
    return {status:result.status,body:await result.json()};
  }
  function json(res,status,value) {res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","referrer-policy":"no-referrer","x-content-type-options":"nosniff"});res.end(JSON.stringify(value));}
  function safe(data){return {status:data.status,message:data.message,failure_code:data.failure_code,account_email_masked:data.account_email_masked};}
  const server = http.createServer(async(req,res)=>{
    try {
      const expectedHost="127.0.0.1:"+server.address().port;
      if(req.headers.host!==expectedHost)return json(res,403,{error:"请使用回环地址访问"});
      const url=new URL(req.url,"http://"+expectedHost);
      if(req.method==="GET"&&url.pathname==="/"){
        res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store","referrer-policy":"no-referrer",
          "content-security-policy":"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});
        return res.end(readFileSync(new URL("./index.html",import.meta.url),"utf8").replace("BROWSER_TOKEN_PLACEHOLDER",browserToken));
      }
      if(req.method==="GET"&&url.pathname==="/client.js"){
        res.writeHead(200,{"content-type":"application/javascript; charset=utf-8","x-content-type-options":"nosniff"});
        return res.end(readFileSync(new URL("./client.js",import.meta.url)));
      }
      if(req.method==="POST"&&url.pathname==="/api/redeem"){
        if(req.headers.origin!=="http://"+expectedHost||req.headers["x-demo-token"]!==browserToken)return json(res,403,{error:"来源校验失败"});
        if(Date.now()-windowAt>60000){windowAt=Date.now();count=0;}if(++count>20)return json(res,429,{error:"请求过于频繁"});
        if(!String(req.headers["content-type"]??"").startsWith("application/json"))return json(res,400,{error:"需要 JSON"});
        const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>64*1024)return json(res,413,{error:"请求过大"});chunks.push(chunk);}
        const input=JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if(!/^[a-zA-Z0-9_-]{8,80}$/.test(input.request_key??"")||!["auto_recharge","cdk"].includes(input.mode)||input.customer_confirmed_email!==true)return json(res,400,{error:"请核对输入与授权"});
        const payload={mode:input.mode,...(input.mode==="cdk"?{code:input.code}:{order_id:input.order_id}),credential:input.credential,customer_confirmed_email:true};
        const result=await call("POST","/v1/redemptions",payload,input.request_key);
        if(result.status!==202)return json(res,result.status,{error:result.body.error?.message??"兑换暂不可用",code:result.body.error?.code??"request_failed"});
        // Only capabilities created by this demo are queryable, not arbitrary Quefa task IDs.
        let capability=requestIds.get(result.body.data.redemption_id);
        if(!capability){if(tasks.size>=500){const first=tasks.keys().next().value;requestIds.delete(tasks.get(first));tasks.delete(first);}capability=randomBytes(24).toString("base64url");tasks.set(capability,result.body.data.redemption_id);requestIds.set(result.body.data.redemption_id,capability);}
        return json(res,202,{data:safe(result.body.data),status_path:"/api/status/"+capability});
      }
      if(req.method==="GET"&&/^\/api\/status\/[A-Za-z0-9_-]{32}$/.test(url.pathname)){
        const task=tasks.get(url.pathname.split("/").at(-1));if(!task)return json(res,404,{error:"查询凭证不存在或已过期"});
        const result=await call("GET","/v1/redemptions/"+encodeURIComponent(task));
        return result.status===200?json(res,200,{data:safe(result.body.data)}):json(res,result.status,{error:"暂时无法查询，请稍后重试"});
      }
      return json(res,404,{error:"not_found"});
    } catch {return json(res,503,{error:"请求未确认，请保留原申请编号重试；不要重复购买"});}
  });
  server.requestTimeout=20000;server.headersTimeout=10000;
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const config={baseUrl:process.env.QUEFA_BASE_URL??"http://127.0.0.1:3200",partnerId:process.env.QUEFA_PARTNER_ID,keyId:process.env.QUEFA_KEY_ID,secret:process.env.QUEFA_CLIENT_SECRET};
  if(!config.partnerId||!config.keyId||!config.secret)throw new Error("请在服务端环境变量配置 Quefa 测试 API 凭证");
  const port=Number(process.env.REDEMPTION_DEMO_PORT??3400);
  createDemoServer(config).listen(port,"127.0.0.1",()=>console.log("仅本地联调：http://127.0.0.1:"+port));
}
