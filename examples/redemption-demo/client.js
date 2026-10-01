"use strict";
const form=document.querySelector("#redeem"),result=document.querySelector("#result"),submit=document.querySelector("#submit"),query=document.querySelector("#query"),newButton=document.querySelector("#new"),attempt=document.querySelector("#attempt");
let requestKey=crypto.randomUUID(),statusPath="",retryBody=null;
attempt.textContent="申请编号："+requestKey;
const states={queued:"已受理，等待派发",running:"处理中，请勿重复提交",succeeded:"充值成功",failed:"充值失败，请核对后联系平台",cancelled:"已取消"};
function show(data){result.textContent=(states[data.status]||"状态确认中")+"\n"+(data.message||"");if(["succeeded","failed","cancelled"].includes(data.status)){query.hidden=true;newButton.hidden=false;}}
form.addEventListener("submit",async e=>{
  e.preventDefault();submit.disabled=true;
  try{
    if(!retryBody){const d=Object.fromEntries(new FormData(form));retryBody=JSON.stringify({request_key:requestKey,mode:d.mode,...(d.mode==="cdk"?{code:d.reference.trim()}:{order_id:d.reference.trim()}),
      credential:d.credentialMode==="session"?{mode:"session",session:d.credentialValue}:{mode:"access_token",access_token:d.credentialValue},customer_confirmed_email:d.confirmed==="on"});}
    for(const n of form.elements)n.disabled=true;
    const response=await fetch("/api/redeem",{method:"POST",headers:{"content-type":"application/json","x-demo-token":document.querySelector('meta[name="demo-token"]').content},body:retryBody}),body=await response.json();
    if(response.status!==202){result.textContent=(body.error||"提交失败")+"；确认结果前请勿重复购买。";if(response.status<500){retryBody=null;for(const n of form.elements)n.disabled=false;}else submit.disabled=false;return;}
    statusPath=body.status_path;retryBody=null;form.querySelector("textarea").value="";show(body.data);query.hidden=false;submit.textContent="已受理";submit.disabled=true;
  }catch{result.textContent="网络结果未知，点击原按钮按同一申请编号重试。不要更换订单。";submit.disabled=false;}
});
query.addEventListener("click",async()=>{query.disabled=true;try{const response=await fetch(statusPath),body=await response.json();if(!response.ok)throw new Error(body.error);show(body.data);}catch(err){result.textContent=err.message||"查询失败，请稍后重试";}finally{query.disabled=false;}});
newButton.addEventListener("click",()=>{form.reset();for(const n of form.elements)n.disabled=false;requestKey=crypto.randomUUID();retryBody=null;statusPath="";attempt.textContent="申请编号："+requestKey;result.textContent="";newButton.hidden=true;query.hidden=true;submit.textContent="确认提交充值";});
