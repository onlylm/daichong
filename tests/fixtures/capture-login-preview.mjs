import {mkdirSync, writeFileSync} from "node:fs";
import {dirname} from "node:path";

const debugBase = process.argv[2] ?? "http://127.0.0.1:9333";
const output = process.argv[3] ?? "artifacts/login-desktop.png";
const width = Number(process.argv[4] ?? 1440);
const height = Number(process.argv[5] ?? 980);
const targets = await (await fetch(debugBase + "/json/list")).json();
const target = targets.find((item) => item.type === "page");
if (!target?.webSocketDebuggerUrl) throw new Error("edge_page_target_not_found");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, {once: true});
  socket.addEventListener("error", reject, {once: true});
});
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", event => {
  const message = JSON.parse(String(event.data));
  if (!message.id) return;
  const handler = pending.get(message.id);
  if (!handler) return;
  pending.delete(message.id);
  if (message.error) handler.reject(new Error(message.error.message));
  else handler.resolve(message.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, {resolve, reject});
  socket.send(JSON.stringify({id, method, params}));
});

await send("Page.enable");
await send("Network.enable");
await send("Network.clearBrowserCookies");
await send("Emulation.setDeviceMetricsOverride", {width, height, deviceScaleFactor: 1, mobile: width <= 720});
await send("Page.navigate", {url: "http://127.0.0.1:3299/workspace"});
await new Promise(resolve => setTimeout(resolve, 900));
const shot = await send("Page.captureScreenshot", {format: "png", captureBeyondViewport: false, fromSurface: true});
mkdirSync(dirname(output), {recursive: true});
writeFileSync(output, Buffer.from(shot.data, "base64"));
socket.close();
console.log(output);
