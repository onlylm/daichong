import type {FastifyInstance} from "fastify";
import {brandFaviconLinks, quefaLogoStackHtml} from "./brand-assets.js";

const gateCsp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export function registerWorkspaceGate(app: FastifyInstance): void {
  app.get("/workspace", async (_request, reply) => reply.type("text/html; charset=utf-8")
    .header("cache-control", "no-store").header("referrer-policy", "no-referrer")
    .header("content-security-policy", gateCsp)
    .header("x-content-type-options", "nosniff").send(workspaceGateHtml));
}

export const workspaceGateHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quefa · 登录</title>${brandFaviconLinks}
<style>
:root{--night:#10243d;--ink:#172a42;--secondary:#4d6178;--muted:#748397;--paper:#fff;--inset:#eef2f6;--line:rgba(16,36,61,.12);--signal:#246bfd;--signal-deep:#154fbf}
*{box-sizing:border-box}body{margin:0;font-family:"Aptos","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;color:var(--ink);background:linear-gradient(180deg,#eef2f6 0%,#f8fafc 52%,#eef2f6 100%)}
button,input{font:inherit}button{border:1px solid var(--line);border-radius:10px;background:var(--paper);color:var(--ink);padding:10px 16px;cursor:pointer;min-height:48px;transition:border-color .15s,color .15s,background .15s,box-shadow .15s,transform .12s}button.primary{background:var(--signal);border-color:var(--signal);color:#fff;width:100%;font-weight:650;box-shadow:0 1px 2px rgba(21,79,191,.16),0 6px 18px rgba(36,107,253,.18)}button.primary:hover{background:var(--signal-deep);border-color:var(--signal-deep);box-shadow:0 4px 16px rgba(36,107,253,.24)}button.primary:active{transform:scale(.985)}button.link{border:0;background:transparent;color:var(--signal);font-weight:650;min-height:auto;padding:0;box-shadow:none}button.link:hover{color:var(--signal-deep);text-decoration:underline}button:disabled{opacity:.6;cursor:wait;transform:none}
input{width:100%;padding:12px 14px;border:0;border-radius:10px;background:var(--inset);box-shadow:inset 0 0 0 1px rgba(16,36,61,.10);min-height:48px;color:var(--ink);transition:background .15s,box-shadow .15s}input::placeholder{color:var(--muted)}input:hover{background:#e8eef4}input:focus{outline:none;background:#fff;box-shadow:inset 0 0 0 1px var(--signal),0 0 0 4px rgba(36,107,253,.10)}
label{display:grid;gap:6px;font-size:12px;font-weight:650;letter-spacing:.02em;color:var(--secondary)}h1{margin:0;font-size:28px;font-weight:650;letter-spacing:-.6px;color:var(--night)}.form-lead{margin:8px 0 0;color:var(--muted);font-size:13px;line-height:1.65}
.gate{min-height:100svh;display:grid;place-items:center;padding:28px 20px}.card{width:min(420px,100%);padding:34px 32px 30px;background:var(--paper);border:1px solid rgba(16,36,61,.08);border-radius:18px;box-shadow:0 1px 2px rgba(16,36,61,.04),0 10px 28px rgba(16,36,61,.08),0 28px 72px rgba(16,36,61,.10)}
.brand-stack{display:flex;flex-direction:column;align-items:center;text-align:center;gap:14px;margin-bottom:26px;color:var(--night)}.brand-mark-wrap{display:grid;place-items:center;flex:none}.brand-mark{display:block;width:32px;height:32px;flex:none}.brand-mark-lg{width:58px;height:58px;filter:drop-shadow(0 10px 24px rgba(36,107,253,.22))}.brand-wordmark{display:grid;gap:5px}.brand-wordmark strong{font-size:26px;font-weight:750;letter-spacing:-.7px;line-height:1}.brand-wordmark span{font-size:11px;font-weight:650;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
form{display:grid;gap:16px;margin-top:20px}.switch{display:flex;flex-wrap:wrap;gap:6px;margin-top:18px;padding-top:18px;border-top:1px solid var(--line);font-size:13px;color:var(--secondary);align-items:center;justify-content:center}
.error{color:#b91c1c;background:#fef2f2;padding:10px 12px;border-radius:8px;font-size:13px;margin:0}.mfa-key{display:block;margin:10px 0;padding:12px;background:var(--inset);border-radius:8px;font:650 15px ui-monospace,Consolas,monospace;letter-spacing:.06em;word-break:break-all;user-select:all}
.recovery{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:14px 0}.recovery code{padding:10px;background:var(--inset);border-radius:6px;font-size:13px;user-select:all}
.hidden{display:none!important}#notice:not(:empty){position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:10;background:var(--night);color:#fff;border-radius:10px;padding:12px 20px;max-width:min(90vw,680px);font-size:14px;box-shadow:0 12px 40px rgba(15,23,42,.18)}
</style></head>
<body><div class="gate"><div class="card">${quefaLogoStackHtml}
<div id="view-login"><div class="form-head"><h1>登录</h1><p class="form-lead">使用平台或代理商账号进入工作台</p></div><form id="login-form"><label>账号<input name="username" type="text" autocomplete="username" placeholder="用户名 / 邮箱" required></label><label>密码<input name="password" type="password" autocomplete="current-password" placeholder="请输入密码" required></label><p class="error hidden" id="login-error" role="alert"></p><button class="primary" type="submit">登录</button></form><div class="switch" id="register-switch" hidden><span>还没有账号？</span><button type="button" class="link" id="goto-register">立即注册</button></div></div>
<div class="hidden" id="view-register"><div class="form-head"><h1>注册代理商</h1><p class="form-lead">提交邮箱与密码，系统将自动开通代理工作台</p></div><form id="register-form"><label>邮箱<input name="email" type="email" autocomplete="email" placeholder="name@company.com" required></label><label>密码<input name="password" type="password" autocomplete="new-password" placeholder="至少 8 位" required></label><p class="error hidden" id="register-error" role="alert"></p><button class="primary" type="submit">注册并进入工作台</button></form><div class="switch"><span>已有账号？</span><button type="button" class="link" id="goto-login">返回登录</button></div></div>
<div class="hidden" id="view-mfa"><h1 id="mfa-title">验证</h1><div id="mfa-secret-wrap" class="hidden"><code class="mfa-key" id="mfa-secret"></code></div><form id="mfa-form"><label>验证码<input name="code" autocomplete="one-time-code" required minlength="6" maxlength="32"></label><p class="error hidden" id="mfa-error" role="alert"></p><button class="primary" type="submit" id="mfa-submit">继续</button></form><div class="switch"><button type="button" class="link" id="mfa-back">返回登录</button></div></div>
<div class="hidden" id="view-recovery"><h1>保存恢复码</h1><div class="recovery" id="recovery-list"></div><button class="primary" type="button" id="recovery-done">进入工作台</button></div>
</div></div><div id="notice" role="status" aria-live="polite"></div>
<script>
(function(){
  const appPath="/workspace/app";
  const views={login:document.getElementById("view-login"),register:document.getElementById("view-register"),mfa:document.getElementById("view-mfa"),recovery:document.getElementById("view-recovery")};
  let mfaChallenge=null;
  function show(name){for(const [k,v] of Object.entries(views))v.classList.toggle("hidden",k!==name);}
  function enterApp(){location.replace(appPath+(location.search||""));}
  async function api(path,method,body){const res=await fetch("/workspace/api"+path,{method,credentials:"same-origin",headers:{"accept":"application/json",...(body?{"content-type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});const raw=await res.text();let value={};if(raw)try{value=JSON.parse(raw);}catch{throw new Error("请求失败");}if(!res.ok)throw new Error(value.error?.message||"请求失败");return value;}
  function setError(id,msg){const el=document.getElementById(id);el.textContent=msg||"";el.classList.toggle("hidden",!msg);}
  function showMfa(challenge){mfaChallenge=challenge;document.getElementById("mfa-title").textContent=challenge.enrollment?"绑定验证器":"验证";document.getElementById("mfa-secret-wrap").classList.toggle("hidden",!challenge.enrollment);if(challenge.enrollment)document.getElementById("mfa-secret").textContent=challenge.secret;setError("mfa-error","");show("mfa");}
  function showRecovery(result){document.getElementById("recovery-list").replaceChildren(...(result.recovery_codes||[]).map(code=>{const n=document.createElement("code");n.textContent=code;return n;}));show("recovery");}
  document.getElementById("goto-register").onclick=()=>show("register");
  document.getElementById("goto-login").onclick=()=>show("login");
  document.getElementById("mfa-back").onclick=()=>{mfaChallenge=null;show("login");};
  document.getElementById("recovery-done").onclick=()=>enterApp();
  document.getElementById("login-form").addEventListener("submit",async e=>{e.preventDefault();const btn=e.target.querySelector("button[type=submit]");btn.disabled=true;setError("login-error","");try{const data=Object.fromEntries(new FormData(e.target));const result=await api("/auth/login","POST",data);if(result.mfa)return showMfa(result.mfa);enterApp();}catch(err){setError("login-error",err.message);}finally{btn.disabled=false;}});
  document.getElementById("register-form").addEventListener("submit",async e=>{e.preventDefault();const btn=e.target.querySelector("button[type=submit]");btn.disabled=true;setError("register-error","");try{const data=Object.fromEntries(new FormData(e.target));await api("/auth/register","POST",{email:data.email,password:data.password});sessionStorage.setItem("quefa_welcome","1");enterApp();}catch(err){setError("register-error",err.message);}finally{btn.disabled=false;}});
  document.getElementById("mfa-form").addEventListener("submit",async e=>{e.preventDefault();const btn=document.getElementById("mfa-submit");btn.disabled=true;setError("mfa-error","");try{const code=new FormData(e.target).get("code");const result=await api("/auth/mfa/verify","POST",{challenge_token:mfaChallenge.challenge_token,code});if(result.recovery_codes)return showRecovery(result);enterApp();}catch(err){setError("mfa-error",err.message);}finally{btn.disabled=false;}});
  api("/auth/config").then(r=>{const on=!!r.registrationEnabled&&!location.hostname.startsWith("admin.");document.getElementById("register-switch").hidden=!on;if(new URLSearchParams(location.search).get("register")==="1"&&on)show("register");}).catch(()=>{});
  fetch("/workspace/api/auth/me",{credentials:"same-origin",headers:{accept:"application/json"}}).then(r=>{if(r.ok)enterApp();}).catch(()=>{});
})();
</script></body></html>`;
