const endpoint = process.env.CDP_ENDPOINT ?? "http://127.0.0.1:9223";
const url = process.argv[2] ?? "https://tibo.ink/developers";

const target = await fetch(`${endpoint}/json/new?${encodeURIComponent(url)}`, {method: "PUT"}).then(response => {
  if (!response.ok) throw new Error(`Cannot create browser target: ${response.status}`);
  return response.json();
});

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, {once: true});
  socket.addEventListener("error", reject, {once: true});
});

let nextId = 0;
const pending = new Map();
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (!message.id) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

function send(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({id, method, params}));
  return new Promise((resolve, reject) => pending.set(id, {resolve, reject}));
}

await send("Page.enable");
await send("Page.navigate", {url});
await new Promise(resolve => setTimeout(resolve, 1800));
await send("Runtime.evaluate", {expression: "document.querySelector('#orders').scrollIntoView();"});
await new Promise(resolve => setTimeout(resolve, 350));
await send("Runtime.evaluate", {expression: "syncSectionNavigation();"});

const evaluation = await send("Runtime.evaluate", {
  returnByValue: true,
  expression: `(() => {
    const aside = document.querySelector("aside");
    const rect = aside.getBoundingClientRect();
    return {
      scrollY: Math.round(window.scrollY),
      innerHeight: window.innerHeight,
      marker: Math.round(window.scrollY + Math.max(160, window.innerHeight * .42)),
      asidePosition: getComputedStyle(aside).position,
      asideTop: Math.round(rect.top),
      asideHeight: Math.round(rect.height),
      activeHref: document.querySelector("aside > a.is-active")?.getAttribute("href") ?? null,
      ordersTop: Math.round(document.querySelector("#orders").getBoundingClientRect().top),
      sectionOffsets: [...document.querySelectorAll("main > section[id]")].map(section => [section.id, section.offsetTop]),
    };
  })()`,
});

const result = evaluation.result.value;
console.log(JSON.stringify(result));
await send("Browser.close");

if (result.scrollY < 500 || result.asidePosition !== "sticky" || result.asideTop !== 68 || result.activeHref !== "#orders") {
  process.exitCode = 1;
}
