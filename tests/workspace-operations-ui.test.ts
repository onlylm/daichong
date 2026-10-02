import {runInNewContext} from "node:vm";
import {randomUUID} from "node:crypto";
import {describe, expect, it, vi} from "vitest";
import {workspaceJs} from "../src/operations/workspace-page.js";

// Technical DOM regressions for the shipped JS, not a real-browser acceptance claim.
class UiNode {
  className = "";
  dataset: Record<string, string> = {};
  children: UiNode[] = [];
  parent: UiNode | null = null;
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(...args: any[]) => unknown>>();
  disabled = false;
  open = false;
  value = "";
  scrollTop = 0;
  constructor(readonly tagName: string, private text = "") {}
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.text = value; this.children = []; }
  get innerHTML(): string { return this.textContent; }
  set innerHTML(value: string) { this.textContent = value.replace(/<[^>]*>/g, ""); }
  get childElementCount() { return this.children.filter(child => child.tagName !== "#text").length; }
  get childNodes() { return this.children; }
  get isConnected(): boolean { return this.tagName === "body" || Boolean(this.parent?.isConnected); }
  classList = {
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    add: (name: string) => { this.classList.toggle(name, true); },
    remove: (name: string) => { this.classList.toggle(name, false); },
    toggle: (name: string, force?: boolean) => {
      const values = new Set(this.className.split(/\s+/).filter(Boolean)), add = force ?? !values.has(name);
      if (add) values.add(name); else values.delete(name);
      this.className = [...values].join(" "); return add;
    },
  };
  setAttribute(name: string, value: string) {
    if (name === "class") this.className = value; else this.attributes.set(name, value);
    if (name === "value") this.value = value;
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  getAttribute(name: string) { return name === "class" ? this.className : this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  append(...children: UiNode[]) { for (const child of children) { child.remove(); child.parent = this; this.children.push(child); } }
  replaceChildren(...children: UiNode[]) { for (const child of this.children) child.parent = null; this.children = []; this.text = ""; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  addEventListener(name: string, listener: (...args: any[]) => unknown) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  async click() { for (const listener of this.listeners.get("click") ?? []) await listener({target: this, preventDefault() {}}); }
  showModal() { this.open = true; this.setAttribute("open", ""); }
  close() { this.open = false; this.removeAttribute("open"); for (const listener of this.listeners.get("close") ?? []) listener(); }
  focus() {}
  scrollTo() {}
  querySelectorAll(selector: string): UiNode[] {
    const matches = (node: UiNode) => {
      const simple = selector.split(" ").at(-1)!;
      const attr = simple.match(/\[([^=\]]+)(?:=["']?([^\]"']+)["']?)?\]/);
      const base = simple.replace(/\[[^\]]+\]/g, "");
      const baseMatch = !base || (base.startsWith("#") ? node.getAttribute("id") === base.slice(1)
        : base.startsWith(".") ? node.classList.contains(base.slice(1)) : node.tagName === base);
      return baseMatch && (!attr || (attr[2] === undefined ? node.getAttribute(attr[1]!) !== null : node.getAttribute(attr[1]!) === attr[2]));
    };
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}

const response = (value: unknown) => ({ok: true, status: 200, text: async () => JSON.stringify(value)}) as Response;
function harness(fetcher: typeof fetch) {
  const body = new UiNode("body"), app = new UiNode("div"), content = new UiNode("main"), notice = new UiNode("div");
  app.setAttribute("id", "app"); content.setAttribute("id", "content"); notice.setAttribute("id", "notice");
  body.append(app, notice); app.append(content);
  const document = {hidden: false, body, activeElement: null, querySelector: (selector: string) => body.querySelector(selector),
    createElement: (tag: string) => new UiNode(tag), createTextNode: (text: string) => new UiNode("#text", text), addEventListener() {}};
  const context: {hooks?: any; [key: string]: unknown} = {fetch: fetcher, Node: UiNode, AbortController, setTimeout, clearTimeout,
    URL, URLSearchParams, Date, document, crypto: {randomUUID}, history: {pushState() {}, replaceState() {}},
    location: {origin: "https://tibo.test", hostname: "tibo.test", protocol: "https:", pathname: "/workspace/app", search: ""},
    window: {addEventListener() {}}, localStorage: {getItem: () => null}};
  const source = workspaceJs.split("\n").filter(line => !line.startsWith("applyEntryQuery();")
    && !line.startsWith('api("/auth/config")') && !line.startsWith('api("/auth/me")')).join("\n");
  runInNewContext(source + `\nglobalThis.hooks={render,globalSearch,auditTrail,runtimeStatus,searchResultAction,
    openInvoiceApplication,openInvoiceDetail,invoiceFormFields,orderDetailRenderMark,openFinanceMetric,financeMetricTiles,date,
    setTab:name=>{tab=name;},setSearch:(query,kind="all",page=1)=>{globalSearchText=query;globalSearchKind=kind;globalSearchPage=page;},
    identity:(role="platform_admin")=>{me={id:"test-user",role,displayName:"测试人员"};merchant=role.startsWith("agent_")?"m1":"";perms=["*"];},
    clearViews:()=>viewLoadedAt.clear(),get cache(){return responseCache;}};`, context);
  context.hooks.identity();
  return {h: context.hooks, body, content, notice};
}

const searchResult = (title: string) => ({data: {total: 1, groups: [{kind: "order", label: "订单",
  meta: {total: 1, page: 1, limit: 10, pages: 1}, data: [{id: "ord1", title, description: "Plus", orderId: "ord1"}]}]}});
const auditResult = (action: string) => ({data: [{id: "aud1", action, actorId: "admin", targetType: "order", targetId: "ord1",
  requestId: "req1", orderId: "ord1", createdAt: "2026-10-02T01:02:03.000Z"}], meta: {total: 1, page: 1, limit: 30, pages: 1}});
const runtimeResult = (status: string) => ({data: {checkedAt: "2026-10-02T02:00:00.000Z", worker: {status, heartbeatAt: null, lanes: []},
  backup: {label: "未检测", status: "undetected", checkedAt: null}, queue: {active: 0, oldestAt: null, oldestOrderId: null}, scope: "只读，不执行真实交易"}});

describe("shipped operations UI regressions", () => {
  it.each([
    {tab: "globalSearch", title: "全局搜索", first: "SEARCH-FIRST", second: "SEARCH-NEW", result: searchResult},
    {tab: "auditTrail", title: "操作审计", first: "audit.first", second: "audit.new", result: auditResult},
  ])("renders $tab through the real router and propagates forced refresh to the network", async item => {
    let value = item.first;
    const fetcher = vi.fn(async () => response(item.result(value))), {h, content} = harness(fetcher as typeof fetch);
    h.setSearch("SEARCH"); h.setTab(item.tab);
    await h.render();
    expect(content.textContent).toContain(item.title);
    expect(content.textContent).toContain(item.first);
    value = item.second;
    await h.render(); expect(fetcher).toHaveBeenCalledTimes(1);
    await h.render({force: true});
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(content.textContent).toContain(item.second);
    expect(content.textContent).not.toContain(item.first);
  });

  it("renders runtime/backup as undetected and its refresh button fetches current health", async () => {
    let status = "missing";
    const fetcher = vi.fn(async () => response(runtimeResult(status))), {h, content} = harness(fetcher as typeof fetch);
    h.setTab("runtimeStatus"); await h.render();
    expect(content.textContent).toContain("运行备份"); expect(content.textContent).toContain("Worker：未检测");
    expect(content.textContent).toContain("不是实时备份成功证明");
    status = "degraded";
    await content.querySelectorAll("button").find(button => button.textContent === "刷新状态")!.click();
    expect(fetcher).toHaveBeenCalledTimes(2); expect(content.textContent).toContain("Worker：异常");
  });

  it("opens the exact wallet search result in a detail dialog instead of just navigating to a wallet list", async () => {
    const fetcher = vi.fn(), {h, body} = harness(fetcher as unknown as typeof fetch);
    const action: UiNode = h.searchResultAction({id: "entry-exact-002", title: "PAYMENT-REF-002", merchantId: "m1",
      description: "采购变动 ¥110.00 / 收益变动 ¥-25.00", occurredAt: "2026-10-02T02:00:00Z"}, "wallet");
    await action.click();
    const dialog = body.querySelector("dialog")!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain("entry-exact-002"); expect(dialog.textContent).toContain("PAYMENT-REF-002");
    expect(dialog.textContent).toContain("¥-25.00"); expect(dialog.textContent).toContain("查看代理钱包");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reads the current paid order amount and renders it read-only with the separate five-percent fee", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request) => response({data: {id: "ord1", canApplyInvoice: true, saleAmount: "1000.00", supplyAmount: "110.00",
      payment: {receivedAmount: "1000.00"}}})), {h, body} = harness(fetcher as typeof fetch);
    h.identity("agent_owner"); await h.openInvoiceApplication({id: "ord1", saleAmount: "110.00"});
    const amount = body.querySelector('input[name="invoiceAmount"]')!;
    expect(amount.value).toBe("1000.00"); expect(amount.getAttribute("readonly")).toBe("true");
    expect(body.querySelector(".invoice-fee-preview")!.textContent).toContain("¥50.00");
    expect(body.textContent).toContain("支付提交");
    expect(fetcher.mock.calls[0]![0]).toContain("/orders/ord1");
  });

  it("rechecks current invoice eligibility before opening a stale order's payment form", async () => {
    const fetcher = vi.fn(async () => response({data: {id: "ord1", canApplyInvoice: false, saleAmount: "1000.00"}}));
    const {h, body} = harness(fetcher as typeof fetch);
    h.identity("agent_owner");
    await expect(h.openInvoiceApplication({id: "ord1", canApplyInvoice: true, saleAmount: "1000.00"}))
      .rejects.toThrow("当前订单暂不可申请开票");
    expect(body.querySelector("dialog")).toBeNull();
    expect(body.querySelector('input[name="invoiceAmount"]')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    {role: "agent_owner", status: "awaiting_payment", blocked: "支付提交"},
    {role: "platform_admin", status: "submitted", blocked: "开始处理"},
    {role: "platform_admin", status: "processing", blocked: "登记开票完成"},
    {role: "agent_owner", status: "issued", blocked: "支付提交"},
  ])("preserves $status invoice history while suppressing $blocked when review is required", async item => {
    const invoice = {id: "inv1", orderId: "ord1", status: item.status, requiresReview: true, reviewReason: "关联订单已退款",
      invoiceTitle: "原申请公司", taxId: "91310000MA12345678", category: "技术服务费", invoiceAmount: "1000.00", feeAmount: "50.00",
      recipientEmail: "finance@example.com", contactName: "原联系人", invoiceNo: "INV-HISTORY-0001", reviewNote: "原交付说明"};
    const {h, body} = harness(vi.fn(async () => response({data: invoice})) as typeof fetch);
    h.identity(item.role); await h.openInvoiceDetail({id: "inv1"});
    const dialog = body.querySelector("dialog")!;
    expect(dialog.textContent).toContain("待核对：关联订单已退款");
    expect(dialog.textContent).toContain("已有付款和发票记录保留");
    expect(dialog.textContent).toContain("INV-HISTORY-0001"); expect(dialog.textContent).toContain("原交付说明");
    expect(dialog.textContent).toContain("¥1000.00"); expect(dialog.textContent).toContain("¥50.00");
    expect(dialog.querySelectorAll("button").some(button => button.textContent === item.blocked)).toBe(false);
  });

  it("invalidates order detail rendering for derived invoice review and diagnostic changes", () => {
    const {h} = harness(vi.fn() as unknown as typeof fetch), base = {paymentStatus: "paid", invoiceApplication: {
      id: "inv1", status: "submitted", version: 1, requiresReview: false, reviewReason: null, expectedInvoiceAmount: "135.00"},
      fulfillments: [{id: "ful1", status: "failed", diagnostic: {publicCode: "credential_invalid"}}], refunds: []};
    const mark = h.orderDetailRenderMark(base);
    expect(h.orderDetailRenderMark({...base, invoiceApplication: {...base.invoiceApplication, requiresReview: true}})).not.toBe(mark);
    expect(h.orderDetailRenderMark({...base, invoiceApplication: {...base.invoiceApplication, reviewReason: "退款待核"}})).not.toBe(mark);
    expect(h.orderDetailRenderMark({...base, invoiceApplication: {...base.invoiceApplication, expectedInvoiceAmount: "100.00"}})).not.toBe(mark);
    expect(h.orderDetailRenderMark({...base, fulfillments: [{...base.fulfillments[0], diagnostic: {publicCode: "supplier_unavailable"}}]})).not.toBe(mark);
    expect(h.orderDetailRenderMark({...base, cdkDiagnostic: {publicCode: "code_disabled"}})).not.toBe(mark);
  });

  it.each(["refunds", "net_receipts"])("renders %s by actual refund event time and retains negative net outflow", async metric => {
    const occurredAt = "2026-10-02T02:03:04.000Z", paidAt = "2026-09-20T01:01:01.000Z";
    const fetcher = vi.fn(async (_url: string | URL | Request) => response({basis: "按发生日", meta: {total: 1, page: 1, limit: 20, pages: 1}, data: [{
      orderId: "ord-refund-old", merchantName: "测试代理", occurredAt, paidAt, entryType: "refund", refundType: "partial",
      refundId: "refund-event-001", receiptAmount: "0.00", refundAmount: "20.00", netReceipts: "-20.00"}]}));
    const {h, body} = harness(fetcher as typeof fetch); await h.openFinanceMetric(metric, "2026-10-02");
    const dialog = body.querySelector("dialog")!;
    expect(dialog.textContent).toContain("发生时间"); expect(dialog.textContent).toContain("refund-event-001");
    expect(dialog.textContent).toContain(h.date(occurredAt)); expect(dialog.textContent).not.toContain(h.date(paidAt));
    expect(dialog.textContent).toContain("¥-20.00"); expect(dialog.textContent).toContain("负数表示当日净流出");
    expect(fetcher.mock.calls[0]![0]).toContain("day=2026-10-02&metric=" + metric);
  });
});
