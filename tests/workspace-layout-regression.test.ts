import {runInNewContext} from "node:vm";
import {randomUUID} from "node:crypto";
import {describe, expect, it, vi} from "vitest";
import {workspaceAppHtml, workspaceCss, workspaceJs} from "../src/operations/workspace-page.js";
import {workspaceCss as sharedWorkspaceCss} from "../src/operations/workspace-styles.js";

// These are shipped-asset/DOM contracts, not browser layout or accessibility acceptance.
// Resolve source order, selector specificity, !important and viewport media rules so
// an obsolete drawer rule cannot pass merely because a newer declaration exists.
type Rule = {selector: string; declarations: Array<[string, string]>; media: string[]};
function cssRules(source: string, media: string[] = []): Rule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, ""), rules: Rule[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("{", cursor); if (open < 0) break;
    const selector = text.slice(cursor, open).trim();
    let depth = 1, end = open + 1;
    while (end < text.length && depth) { if (text[end] === "{") depth++; if (text[end] === "}") depth--; end++; }
    const body = text.slice(open + 1, end - 1); cursor = end;
    if (selector.startsWith("@media")) rules.push(...cssRules(body, [...media, selector]));
    else if (!selector.startsWith("@")) for (const item of selector.split(",")) {
      const declarations = body.split(";").flatMap(value => {
        const colon = value.indexOf(":"); return colon < 0 ? [] : [[value.slice(0, colon).trim(), value.slice(colon + 1).trim()] as [string, string]];
      });
      rules.push({selector: item.trim(), declarations, media});
    }
  }
  return rules;
}
const rules = cssRules(workspaceCss);

class Element {
  className = ""; children: Element[] = []; parent: Element | null = null;
  attributes = new Map<string, string>(); listeners = new Map<string, Array<(...args: any[]) => unknown>>();
  dataset: Record<string, string> = {}; open = false; disabled = false; value = "";
  showModal = vi.fn(() => { this.open = true; this.setAttribute("open", ""); });
  focus = vi.fn(); scrollTo() {}
  constructor(readonly tagName: string, private text = "") {}
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.text = value; this.children = []; }
  get innerHTML() { return this.textContent; }
  set innerHTML(value: string) { this.textContent = value.replace(/<[^>]*>/g, ""); }
  get childNodes() { return this.children; }
  get childElementCount() { return this.children.filter(child => child.tagName !== "#text").length; }
  get isConnected(): boolean { return this.tagName === "body" || Boolean(this.parent?.isConnected); }
  classList = {contains: (value: string) => this.className.split(/\s+/).includes(value),
    add: (value: string) => { this.className += " " + value; },
    remove: (value: string) => { this.className = this.className.split(/\s+/).filter(item => item !== value).join(" "); },
    toggle: (value: string, force?: boolean) => { const on = force ?? !this.classList.contains(value); if (on) this.classList.add(value); else this.classList.remove(value); return on; }};
  setAttribute(name: string, value: string) {
    if (name === "class") this.className = value; else this.attributes.set(name, String(value));
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = String(value);
  }
  getAttribute(name: string) { return name === "class" ? this.className : this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  append(...items: Element[]) { for (const item of items) { item.remove(); item.parent = this; this.children.push(item); } }
  replaceChildren(...items: Element[]) { for (const item of this.children) item.parent = null; this.children = []; this.text = ""; this.append(...items); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); this.parent = null; }
  addEventListener(name: string, listener: (...args: any[]) => unknown) { this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]); }
  async click() { for (const fn of this.listeners.get("click") ?? []) await fn({target: this, preventDefault() {}}); }
  close() { this.open = false; this.removeAttribute("open"); for (const fn of this.listeners.get("close") ?? []) fn(); }
  querySelectorAll(selector: string): Element[] { return this.children.flatMap(child => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}
function simpleMatches(node: Element, selector: string): boolean {
  if (selector === ":root") return node.tagName === "html";
  const has = selector.match(/:has\(([^)]+)\)/);
  if (has && !node.querySelector(has[1]!)) return false;
  selector = selector.replace(/:has\([^)]+\)/g, "");
  if (selector.endsWith(":empty")) { if (node.children.length || node.textContent) return false; selector = selector.slice(0, -6); }
  // Dynamic pseudoclasses are not active in these resting/open fixtures.
  if (selector.includes(":")) return false;
  const attributes = [...selector.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)];
  const base = selector.replace(/\[[^\]]+\]/g, ""), tag = base.match(/^[\w-]+/)?.[0];
  return (!tag || tag === node.tagName)
    && [...base.matchAll(/\.([\w-]+)/g)].every(item => node.classList.contains(item[1]!))
    && [...base.matchAll(/#([\w-]+)/g)].every(item => node.getAttribute("id") === item[1])
    && attributes.every(item => item[2] === undefined ? node.getAttribute(item[1]!) !== null : node.getAttribute(item[1]!) === item[2]);
}
function matches(node: Element, selector: string): boolean {
  const parts = selector.trim().split(/\s+/); let at: Element | null = node;
  if (!simpleMatches(node, parts.pop()!)) return false;
  while (parts.length) {
    const part = parts.pop()!;
    if (part === ">") { at = at?.parent ?? null; if (!at || !simpleMatches(at, parts.pop()!)) return false; }
    else { at = at?.parent ?? null; while (at && !simpleMatches(at, part)) at = at.parent; if (!at) return false; }
  }
  return true;
}
function effective(node: Element, width: number): Record<string, string> {
  const inherited = node.parent ? effective(node.parent, width) : {}, result: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) if (key.startsWith("--") || key === "color") result[key] = value;
  const ranks = new Map<string, number>();
  for (const [index, rule] of rules.entries()) {
    if (!rule.media.every(media => !/prefers-reduced-motion|hover\s*:/.test(media)
      && [...media.matchAll(/\((min|max)-width\s*:\s*(\d+)px\)/g)]
        .every(([, op, amount]) => op === "min" ? width >= Number(amount) : width <= Number(amount)))) continue;
    if (!matches(node, rule.selector)) continue;
    const specificity = (rule.selector.match(/#/g)?.length ?? 0) * 100 + (rule.selector.match(/[.\[]|:(?!:)/g)?.length ?? 0) * 10
      + rule.selector.split(/[ >]+/).filter(part => /^[a-z]/i.test(part)).length;
    for (const [property, raw] of rule.declarations) {
      const important = /!important\s*$/.test(raw), value = raw.replace(/\s*!important\s*$/, ""), rank = Number(important) * 1e9 + specificity * 1e5 + index;
      if (rank >= (ranks.get(property) ?? -1)) { result[property] = value; ranks.set(property, rank); }
    }
  }
  const resolve = (value: string, depth = 0): string => depth > 8 ? value : value.replace(/var\((--[\w-]+)\)/g,
    (whole, key: string) => result[key] ? resolve(result[key]!, depth + 1) : whole);
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value === "inherit" ? inherited[key] ?? value : resolve(value)]));
}
function size(value: string | undefined, width: number, height: number, axis: "width" | "height" = "width"): number {
  if (!value || value === "none" || value === "auto") return Number.POSITIVE_INFINITY;
  const expression = value.replace(/(\d*\.?\d+)%/g, (_, amount: string) => String(Number(amount) * (axis === "width" ? width : height) / 100))
    .replace(/(\d*\.?\d+)(svh|dvh|vh|vw|rem|px)/g, (_, amount: string, unit: string) =>
    String(Number(amount) * ({svh: height / 100, dvh: height / 100, vh: height / 100, vw: width / 100, rem: 15, px: 1}[unit] ?? 1)))
    .replace(/calc\(/g, "(").replace(/\bmin\(/g, "Math.min(").replace(/\bmax\(/g, "Math.max(");
  if (!/^[\d\s.+*/(),-]+$/.test(expression.replace(/Math\.(min|max)/g, ""))) throw new Error("Unsupported CSS size: " + value);
  return runInNewContext(expression);
}
function tree(tag: string, className: string, parent?: Element): Element {
  const node = new Element(tag); node.className = className; parent?.append(node); return node;
}
function fixture() { const html = tree("html", ""), body = tree("body", "", html), shell = tree("div", "shell", body); return {html, body, shell}; }
function harness(permissions = ["*"]) {
  const body = new Element("body"), trigger = tree("button", "trigger", body), calls: Array<[string, unknown]> = [];
  const document = {body, activeElement: trigger, hidden: false, querySelector: (s: string) => body.querySelector(s),
    createElement: (tag: string) => new Element(tag), createTextNode: (text: string) => new Element("#text", text), addEventListener() {}, removeEventListener() {}};
  const context: {hooks?: any; [key: string]: unknown} = {document, Node: Element, AbortController, setTimeout, clearTimeout, URL, URLSearchParams,
    crypto: {randomUUID}, window: {addEventListener() {}, removeEventListener() {}}, localStorage: {getItem: () => null},
    location: {origin: "https://layout.test", hostname: "layout.test", protocol: "https:", search: ""},
    record: (kind: string, value: unknown) => calls.push([kind, value]), fetch: vi.fn(), testPermissions: permissions};
  const source = workspaceJs.split("\napplyEntryQuery();")[0];
  runInNewContext(source + `\nme={id:"layout-admin",role:"platform_admin"};perms=testPermissions;
    gotoTab=value=>record("tab",value);openOrderDetailModal=value=>record("order",value);
    completeCustomerRefund=value=>record("ordinary-refund",value);completePriceAdjustmentRefund=value=>record("adjustment-refund",value);
    openDailySettlementPay=value=>record("settlement",value);openWalletPanel=value=>record("wallet",value);
    reconcileDailySettlement=value=>record("reconcile-settlement",value);
    actOnWithdrawal=(value,action)=>record("withdrawal",{value,action});
    openInvoiceDetail=value=>record("invoice",value);openInvoicePaymentReview=value=>record("invoice-review",value);
    ticketDetail=value=>record("ticket",value);
    globalThis.hooks={openFormModal,openMessageModal,platformActionCenter,actionQueue,statChips};`, context);
  return {h: context.hooks, body, trigger, calls};
}
function actionFixture(overrides: Record<string, unknown> = {}) {
  return {counts: {tasks: 0, refunds: 0, refundReviews: 0, invoicePaymentReviews: 0, settlements: 0, withdrawals: 0, tickets: 0, invoices: 0},
    worker: {status: "healthy", lanes: []}, checks: {}, capabilities: {}, ...overrides};
}

describe("workspace layout and action preservation", () => {
  it("keeps the extracted stylesheet identical to the workspace asset export", () => {
    expect(workspaceCss.length).toBeGreaterThan(0);
    expect(workspaceCss).toBe(sharedWorkspaceCss);
  });

  it("preserves metric semantics and click targets after label changes in the shared accounting band", async () => {
    const {h} = harness(), tones = ["blue", "mint", "warn"], actions = tones.map(() => vi.fn());
    for (const label of ["业务统计", "已更名的经营指标"]) {
      const view = h.statChips(tones.map((tone, index) => [label, "¥25.00", "点击查看明细", actions[index], tone]),
        {className: "platform-metrics"}) as Element;
      const {body} = fixture(); body.append(view);
      const cards = view.querySelectorAll(".stat-chip-btn");
      expect(cards).toHaveLength(3);
      for (const [index, card] of cards.entries()) {
        expect(card.classList.contains("stat-chip-" + tones[index])).toBe(true);
        expect(card.textContent).toContain(label); expect(card.textContent).toContain("¥25.00");
        await card.click();
      }
    }
    for (const action of actions) expect(action).toHaveBeenCalledTimes(2);
  });

  it("lays the six operating metrics out as one desktop accounting band and two mobile columns", () => {
    const {h} = harness(), {body} = fixture(), section = tree("section", "section business-layer", body);
    const band = h.statChips(["今日收款", "今日净流入", "今日退款", "代理佣金", "今日已付", "履约成功"]
      .map(label => [label, "25", "", () => {}]), {className: "platform-metrics"}) as Element;
    section.append(band);
    expect(band.querySelectorAll("button")).toHaveLength(6);
    for (const width of [1280, 1440, 2560]) {
      const style = effective(band, width);
      expect(style.display).toBe("grid");
      expect(style["grid-template-columns"], `accounting band at ${width}px`).toMatch(/^repeat\(6,\s*minmax\(0,\s*1fr\)\)$/);
    }
    for (const width of [360, 390, 720]) {
      const style = effective(band, width);
      expect(style.display).toBe("grid");
      expect(style["grid-template-columns"], `accounting band at ${width}px`).toMatch(/^repeat\(2,\s*minmax\(0,\s*1fr\)\)$/);
    }
  });

  it("ships the fluid main pane and a non-floating compact topbar at desktop and phone widths", () => {
    expect(workspaceAppHtml).toMatch(/<main class="main">/);
    for (const width of [360, 720, 1440, 2560]) {
      const {shell} = fixture(), main = tree("main", "main", shell), topbar = tree("header", "topbar topbar-compact", main);
      expect(effective(main, width)["max-width"], `main cap at ${width}px`).toBe("none");
      expect(effective(main, width).width).toBe("100%");
      expect(["static", "relative", undefined]).toContain(effective(topbar, width).position);
      expect(effective(topbar, width).transform ?? "none").toBe("none");
      const context = tree("div", "topbar-context", topbar), toolbar = tree("div", "topbar-toolbar", topbar);
      expect(effective(context, width).display).toBe("none");
      expect(effective(topbar, width).display).toBe("none");
      tree("button", "wallet-action", toolbar);
      expect(effective(topbar, width).display).not.toBe("none");
    }
  });

  it.each(["workspace-modal", "workspace-modal workspace-drawer order-detail-modal", "workspace-modal workspace-drawer ticket-detail-drawer"])
    ("keeps %s centred with a bounded, internally scrolling body on desktop and mobile", className => {
      for (const [width, height] of [[1440, 900], [390, 844], [320, 568]] as const) {
        const {body} = fixture(), dialog = tree("dialog", className, body); dialog.setAttribute("open", "");
        const shell = tree("div", "modal-shell", dialog), content = tree("div", "modal-body", shell);
        const modal = effective(dialog, width), layout = effective(shell, width), scroll = effective(content, width);
        expect(modal.margin, `${className} margin at ${width}px`).toBe("auto");
        expect(modal.height).toBe("fit-content");
        expect(size(modal.width, width, height)).toBeLessThanOrEqual(width - 16);
        expect(size(modal["max-height"], width, height, "height")).toBeLessThanOrEqual(height - 16);
        expect(size(layout["max-height"], width, height, "height")).toBeLessThanOrEqual(height - 16);
        expect(["auto", "scroll"]).toContain(scroll["overflow-y"] ?? scroll.overflow);
        expect(scroll["min-height"]).toMatch(/^0(?:px)?$/);
        expect(modal.animation ?? "none").not.toContain("drawer-in");
      }
    });

  it("opens a native labelled modal, keeps its form, and returns focus after closing", async () => {
    const {h, body, trigger} = harness(), run = vi.fn();
    const dialog = h.openFormModal("人工处理", [], "确认登记", run) as Element;
    expect(dialog.tagName).toBe("dialog"); expect(dialog.showModal).toHaveBeenCalledOnce();
    expect(dialog.getAttribute("aria-label")).toBe("人工处理"); expect(dialog.open).toBe(true);
    expect(dialog.querySelector("form")).not.toBeNull(); expect(dialog.textContent).toContain("确认登记");
    await dialog.querySelectorAll("button").find(button => button.textContent === "关闭")!.click();
    expect(body.querySelector("dialog")).toBeNull(); expect(trigger.focus).toHaveBeenCalledOnce(); expect(run).not.toHaveBeenCalled();
  });

  it("keeps per-record refund, order and settlement buttons and respects server capabilities", async () => {
    const {h, calls} = harness(), refund = {id: "refund-23", orderId: "order-23", type: "partial", status: "failed", amount: "10.00"},
      settlement = {id: "settlement-9", merchantName: "代理甲", businessDate: "2026-10-02", payable: "25.00", status: "pending_payment"};
    const data = actionFixture({counts: {tasks: 1, refunds: 1, settlements: 1}, tasks: [{orderId: "order-17", message: "上游结果待核"}],
      refunds: [refund], settlements: [settlement], capabilities: {canReviewRefunds: true, canManageSettlements: true}});
    const view = h.platformActionCenter(data) as Element;
    for (const label of ["处理订单", "重试退款", "确认打款"]) await view.querySelectorAll("button").find(button => button.textContent === label)!.click();
    expect(calls).toEqual([["order", {id: "order-17"}], ["ordinary-refund", refund], ["settlement", settlement]]);
    calls.length = 0;
    const readonly = h.platformActionCenter({...data, capabilities: {}}) as Element;
    expect(readonly.querySelectorAll("button").some(button => ["重试退款", "确认打款"].includes(button.textContent))).toBe(false);
    await readonly.querySelectorAll("button").find(button => button.textContent === "查看退款")!.click();
    expect(calls).toEqual([["order", {id: "order-23"}]]);
  });

  it("keeps every actionable queue, its exact record action and its full-list destination", async () => {
    const {h, calls} = harness();
    const refund = {id: "refund-23", orderId: "order-23", type: "partial", status: "failed", amount: "10.00"};
    const withdrawal = {id: "withdrawal-8", merchantName: "代理甲", amount: "80.00", status: "requested", payoutMethod: "bank"};
    const settlement = {id: "settlement-9", merchantName: "代理甲", businessDate: "2026-10-02", payable: "25.00", status: "paid"};
    const invoice = {id: "invoice-6", merchantName: "代理甲", invoiceAmount: "100.00", feeAmount: "5.00", status: "submitted"};
    const duplicate = {id: "invoice-review-4", merchantName: "代理甲", amount: "5.00", canonicalProviderRef: "paid-first", duplicateProviderRef: "paid-second"};
    const view = h.platformActionCenter(actionFixture({
      counts: {tasks: 1, refunds: 1, refundReviews: 1, invoicePaymentReviews: 1, settlements: 1, withdrawals: 1, tickets: 1, invoices: 1},
      tasks: [{orderId: "order-17", message: "待核对"}], refunds: [refund], withdrawals: [withdrawal], settlements: [settlement],
      invoices: [invoice], invoicePaymentReviews: [duplicate],
      refundReviews: [{orderId: "order-44", differenceAmount: "5.00", reportedAmount: "15.00", recordedAmount: "10.00"}],
      tickets: [{id: "ticket-8", title: "售后咨询", status: "open"}],
      capabilities: {canReviewRefunds: true, canManageSettlements: true, canReviewWithdrawals: true, canManageInvoices: true},
    })) as Element;
    const queues = view.querySelectorAll(".action-queue");
    expect(queues.map(queue => queue.querySelector("h3")!.textContent))
      .toEqual(["补差重复到账", "退款差异", "异常订单", "退款处理", "提现审核", "每日核算", "开票申请", "售后工单"]);
    expect(queues.map(queue => queue.querySelector(".action-count")!.textContent)).toEqual(Array(8).fill("1"));
    for (const label of ["核对两笔流水", "核对订单", "处理订单", "重试退款", "审核提现", "驳回", "到账核销", "处理申请", "回复工单"])
      await view.querySelectorAll("button").find(button => button.textContent === label)!.click();
    expect(calls).toEqual([
      ["invoice-review", duplicate], ["order", {id: "order-44"}], ["order", {id: "order-17"}], ["ordinary-refund", refund],
      ["withdrawal", {value: withdrawal, action: "approve"}], ["withdrawal", {value: withdrawal, action: "reject"}],
      ["reconcile-settlement", settlement], ["invoice", invoice], ["ticket", "ticket-8"],
    ]);
    calls.length = 0;
    for (const queue of queues) await queue.querySelectorAll("button").find(button => button.textContent === "查看全部")!.click();
    expect(calls).toEqual([["tab", "invoices"], ["wallet", "refund-review"], ["tab", "notifications"], ["wallet", "refunds"],
      ["wallet", "withdrawals"], ["wallet", "settlements"], ["tab", "invoices"], ["tab", "tickets"]]);
  });

  it("keeps record lookup available while withholding withdrawal and invoice management without server capabilities", async () => {
    const {h, calls} = harness(["wallet.read", "invoices.read"]);
    const invoice = {id: "invoice-readonly", merchantName: "代理甲", invoiceAmount: "100.00", feeAmount: "5.00", status: "submitted"};
    const view = h.platformActionCenter(actionFixture({counts: {withdrawals: 1, invoices: 1},
      withdrawals: [{id: "withdrawal-readonly", amount: "80.00", status: "requested", payoutMethod: "bank"}], invoices: [invoice],
    })) as Element;
    const buttons = view.querySelectorAll("button"), labels = buttons.map(button => button.textContent);
    for (const label of ["审核提现", "确认打款", "驳回", "处理申请"]) expect(labels).not.toContain(label);
    await buttons.find(button => button.textContent === "查看提现")!.click();
    await buttons.find(button => button.textContent === "查看申请")!.click();
    expect(calls).toEqual([["wallet", "withdrawals"], ["invoice", invoice]]);
  });

  it("keeps configuration readiness out of home queues and shows no runtime alert when the worker is healthy", () => {
    const {h} = harness();
    for (const state of ["healthy", "configured", "ready", "disabled", "missing", "undetected", "failed"]) {
      const view = h.platformActionCenter(actionFixture({checks: {
        payment: {status: state, label: "支付宝配置状态"},
        upstream: {status: state, label: "供应连接配置状态"},
        backup: {status: state, label: "备份配置状态"},
      }})) as Element;
      expect(view.querySelector(".operations-status-rail")).toBeNull();
      expect(view.querySelector(".operations-check")).toBeNull();
      expect(view.querySelector(".overview-runtime-alert")).toBeNull();
      expect(view.querySelectorAll(".action-queue")).toHaveLength(0);
      for (const label of ["支付宝配置状态", "供应连接配置状态", "备份配置状态", "支付通道", "上游供应", "数据备份"])
        expect(view.textContent).not.toContain(label);
      expect(view.textContent).toContain("待办");
    }
  });

  it.each(["degraded", "stale", "stopped"])("shows %s as one compact runtime warning with an exact monitoring link", async status => {
    const {h, calls} = harness(), view = h.platformActionCenter(actionFixture({worker: {
      status, failedLanes: ["fulfillment"], stuckLanes: [], heartbeatAt: "2026-10-02T02:00:00.000Z",
    }})) as Element;
    const alerts = view.querySelectorAll(".overview-runtime-alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.getAttribute("data-tone")).toBe("danger");
    expect(alerts[0]!.textContent).toContain("后台任务");
    expect(view.querySelectorAll(".action-queue")).toHaveLength(0);
    expect(view.querySelector(".operations-status-rail")).toBeNull();
    expect(alerts[0]!.querySelector(".action-list")).toBeNull();
    const open = alerts[0]!.querySelectorAll("button").find(button => button.textContent === "查看运行");
    expect(open).toBeDefined(); await open!.click();
    expect(calls).toEqual([["tab", "runtimeStatus"]]);
  });

  it.each([undefined, {status: "missing"}, {status: "unknown"}])("does not declare missing or unknown runtime evidence healthy or failed: %j", worker => {
    const {h} = harness(), view = h.platformActionCenter(actionFixture({worker})) as Element;
    const alert = view.querySelector(".overview-runtime-alert");
    expect(alert).not.toBeNull(); expect(alert!.getAttribute("data-tone")).toBe("warning");
    expect(alert!.textContent).toMatch(/未确认|未检测|未知/);
    expect(alert!.textContent).not.toMatch(/运行正常|系统正常|已故障|已停止|未启动/);
    expect(view.querySelectorAll(".action-queue")).toHaveLength(0);
  });

  it("retains actionable business queues beside a runtime alert without counting configuration as a business item", async () => {
    const {h, calls} = harness(), view = h.platformActionCenter(actionFixture({
      worker: {status: "stale"}, checks: {payment: {status: "missing", label: "支付宝未启用"}},
      counts: {tasks: 2}, tasks: [{orderId: "order-alert-1", message: "充值结果需要人工确认"}],
    })) as Element;
    expect(view.querySelectorAll(".overview-runtime-alert")).toHaveLength(1);
    const queues = view.querySelectorAll(".action-queue"); expect(queues).toHaveLength(1);
    expect(queues[0]!.textContent).toContain("异常订单"); expect(queues[0]!.querySelector(".action-count")!.textContent).toBe("2");
    expect(view.textContent).not.toContain("支付宝未启用");
    await queues[0]!.querySelectorAll("button").find(button => button.textContent === "处理订单")!.click();
    expect(calls).toEqual([["order", {id: "order-alert-1"}]]);
  });

  it("does not offer admin-only monitoring navigation to read-only staff", () => {
    const {h} = harness(["orders.read"]), view = h.platformActionCenter(actionFixture({worker: {status: "stopped"}})) as Element;
    expect(view.querySelector(".overview-runtime-alert")!.textContent).toContain("请联系管理员核查");
    expect(view.querySelectorAll("button").some(button => button.textContent === "查看运行")).toBe(false);
  });

  it("does not present an unavailable action-center response as an empty business queue", () => {
    const {h} = harness(), view = h.platformActionCenter(actionFixture({moduleStatus: {action: {available: false}}})) as Element;
    expect(view.textContent).toContain("业务待办暂不可用");
    expect(view.textContent).not.toContain("当前没有业务待办");
  });

  it("preserves queue severity, totals and per-queue navigation in the lightweight grouped list", async () => {
    const {h} = harness(), onAll = vi.fn();
    for (const [count, options, tone] of [[null, {}, "danger"], [2, {severity: "urgent"}, "danger"],
      [2, {}, "warning"], [2, {tone: "info"}, "info"], [0, {}, "success"]] as const) {
      const view = h.actionQueue("业务队列", count, "原业务说明", [], "当前没有待办", {...options, onAll}) as Element;
      expect(view.getAttribute("data-tone")).toBe(tone);
      expect(view.querySelector(".action-count")?.textContent).toBe(count === null ? "—" : String(count));
      expect(view.textContent).toContain("原业务说明");
      expect(view.getAttribute("data-state")).toBe(count === null ? "error" : "ready");
      expect(view.getAttribute("data-severity")).toBe("severity" in options ? options.severity : "normal");
      await view.querySelectorAll("button").find(button => button.textContent === "查看全部")!.click();
    }
    expect(onAll).toHaveBeenCalledTimes(5);
    const tickets = h.platformActionCenter(actionFixture({counts: {tickets: 1}, tickets: [{id: "ticket-8", title: "代理咨询", status: "open"}]})) as Element;
    expect(tickets.querySelectorAll(".action-queue").find(item => item.textContent.includes("售后工单"))?.getAttribute("data-tone")).toBe("info");
  });

  it("uses shared neutral queue headers and keeps every record and navigation action at least 40px high", () => {
    const {h} = harness(), {body} = fixture(), headings = new Set<string>();
    for (const tone of ["danger", "warning", "info", "success"]) {
      const action = tree("button", "primary");
      action.textContent = "处理记录";
      const view = h.actionQueue("业务队列", 1, "保留业务说明", [action], "无待办", {tone, onAll: () => {}}) as Element;
      body.append(view);
      for (const width of [390, 1440]) {
        const header = effective(view.querySelector("header")!, width);
        headings.add(header.background ?? header["background-color"] ?? "transparent");
        for (const button of view.querySelectorAll("button")) {
          const minimum = effective(button, width)["min-height"];
          expect(minimum, `${button.textContent} at ${width}px`).toBeDefined();
          expect(size(minimum, width, 900, "height"), `${button.textContent} at ${width}px`).toBeGreaterThanOrEqual(40);
        }
      }
    }
    expect(headings.size).toBe(1);
  });
});
