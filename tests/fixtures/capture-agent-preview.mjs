import {mkdirSync, writeFileSync} from "node:fs";
import {dirname} from "node:path";
import {totpCodeAt} from "../../dist/operations/accounts.js";

const debugBase = process.argv[2] ?? "http://127.0.0.1:9333";
const output = process.argv[3] ?? "artifacts/agent-workspace.png";
const navigationLabel = process.argv[4] ?? "";
const actionLabel = process.argv[5] ?? "";
const username = process.argv[6] ?? "preview-agent";
const password = process.argv[7] ?? "preview-agent-updated-password";
const width = Number(process.argv[8] ?? 1440);
const height = Number(process.argv[9] ?? 980);
const cropSelector = process.argv[10] ?? "";
const targets = await (await fetch(debugBase + "/json/list")).json();
const target = targets.find((item) => item.type === "page");
if (!target?.webSocketDebuggerUrl) throw new Error("edge_page_target_not_found");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {socket.addEventListener("open", resolve, {once: true}); socket.addEventListener("error", reject, {once: true});});
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", event => {
  const message = JSON.parse(String(event.data));
  if (!message.id) return;
  const handler = pending.get(message.id);
  if (!handler) return;
  pending.delete(message.id);
  if (message.error) handler.reject(new Error(message.error.message)); else handler.resolve(message.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, {resolve, reject}); socket.send(JSON.stringify({id, method, params}));
});
await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Network.clearBrowserCookies");
await send("Emulation.setDeviceMetricsOverride", {width, height, deviceScaleFactor: 1, mobile: width <= 720});
await send("Page.navigate", {url: "http://127.0.0.1:3299/workspace"});
await new Promise(resolve => setTimeout(resolve, 700));
const login = await send("Runtime.evaluate", {expression: `(async()=>{
  const response=await fetch('/workspace/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(username)},password:${JSON.stringify(password)}})});
  return {status:response.status,body:await response.text()};
})()`, awaitPromise: true, returnByValue: true});
if (login.result.value.status !== 200) throw new Error("preview_login_failed:" + login.result.value.body);
const loginBody = JSON.parse(login.result.value.body);
if (loginBody.mfa) {
  const code = totpCodeAt(loginBody.mfa.secret);
  const verified = await send("Runtime.evaluate", {expression: `(async()=>{const response=await fetch('/workspace/api/auth/mfa/verify',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({challenge_token:${JSON.stringify(loginBody.mfa.challenge_token)},code:${JSON.stringify(code)}})});return {status:response.status,body:await response.text()}})()`, awaitPromise: true, returnByValue: true});
  if (verified.result.value.status !== 200) throw new Error("preview_mfa_failed:" + verified.result.value.body);
}
await send("Page.navigate", {url: "http://127.0.0.1:3299/workspace"});
await new Promise(resolve => setTimeout(resolve, 1200));
if (navigationLabel) {
  const clicked = await send("Runtime.evaluate", {expression: `(()=>{const label=${JSON.stringify(navigationLabel)};const target=[...document.querySelectorAll('nav button')].find(button=>button.textContent.trim()===label);if(!target)return false;target.click();return true})()`, returnByValue: true});
  if (!clicked.result.value) throw new Error("navigation_target_not_found:" + navigationLabel);
  await new Promise(resolve => setTimeout(resolve, 900));
}
if (actionLabel) {
  const clicked = await send("Runtime.evaluate", {expression: `(()=>{const label=${JSON.stringify(actionLabel)};const target=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()===label);if(!target)return false;target.click();return true})()`, returnByValue: true});
  if (!clicked.result.value) throw new Error("action_target_not_found:" + actionLabel);
  await new Promise(resolve => setTimeout(resolve, 500));
}
let clip;
if (cropSelector) {
  const bounds = await send("Runtime.evaluate", {expression: `(()=>{const node=document.querySelector(${JSON.stringify(cropSelector)});if(!node)return null;const box=node.getBoundingClientRect();return{x:box.left+scrollX,y:box.top+scrollY,width:box.width,height:box.height}})()`, returnByValue: true});
  if (!bounds.result.value) throw new Error("crop_target_not_found:" + cropSelector);
  clip = {...bounds.result.value, scale: 1};
}
const shot = await send("Page.captureScreenshot", {format: "png", captureBeyondViewport: Boolean(clip), fromSurface: true, ...(clip ? {clip} : {})});
mkdirSync(dirname(output), {recursive: true});
writeFileSync(output, Buffer.from(shot.data, "base64"));
socket.close();
console.log(output);
