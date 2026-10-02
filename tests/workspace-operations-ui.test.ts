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
  insertBefore(child: UiNode, reference: UiNode | null) {
    child.remove(); child.parent = this;
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(child); else this.children.splice(index, 0, child);
    return child;
  }
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
    renderOrderDetailContent,orderActionCell,orderDeliveryCell,platformOverview,
    setTab:name=>{tab=name;},setSearch:(query,kind="all",page=1)=>{globalSearchText=query;globalSearchKind=kind;globalSearchPage=page;},
    identity:(role="platform_admin",permissions=["*"])=>{me={id:"test-user",role,displayName:"测试人员"};merchant=role.startsWith("agent_")?"m1":"";perms=permissions;},
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
const overviewActionResult = () => ({data: {
  counts: {tasks: 7, refunds: 3, refundReviews: 0, invoicePaymentReviews: 0, settlements: 2, withdrawals: 0, tickets: 0, invoices: 0},
  capabilities: {canReviewRefunds: true, canReviewWithdrawals: true, canManageSettlements: true, canManageInvoices: true},
  worker: {status: "healthy"}, moduleStatus: {},
  tasks: [{orderId: "ord-attention-001", message: "等待核对充值失败原因", priority: "urgent", createdAt: "2026-10-02T01:00:00Z"}],
  refunds: [{id: "refund-pending-001", orderId: "ord-refund-001", amount: "20.00", type: "partial", status: "requested",
    merchantName: "测试代理", createdAt: "2026-10-02T01:00:00Z"}],
  settlements: [{id: "settlement-001", merchantId: "m1", merchantName: "测试代理", payable: "62.00", businessDate: "2026-10-01",
    status: "pending_payment", generatedAt: "2026-10-01T14:00:00Z"}],
}});
const overviewFinanceResult = () => ({data: {today: {day: "2026-10-02", paidOrders: 21, saleAmount: "6348.00", netSaleAmount: "6103.00",
  refundedAmount: "245.00", marginAmount: "713.00", succeededOrders: 19}}});
function overviewFetch(failFinance: () => boolean = () => false) {
  return vi.fn(async (url: string | URL | Request) => {
    const path = String(url);
    if (path.includes("/finance/summary")) {
      if (failFinance()) throw new Error("核算接口暂不可用");
      return response(overviewFinanceResult());
    }
    if (path.includes("/action-center")) return response(overviewActionResult());
    if (path.includes("/agents")) return response({data: [{id: "m1", name: "测试代理"}]});
    if (path.includes("/orders?")) return response({data: [], meta: {total: 900}});
    throw new Error("unexpected test request: " + path);
  });
}
function expectOverviewActions(workspace: UiNode) {
  const queues = workspace.querySelectorAll(".action-queue");
  expect(queues.map(queue => [queue.querySelector("h3")!.textContent, queue.querySelector(".action-count")!.textContent]))
    .toEqual([["异常订单", "7"], ["退款处理", "3"], ["每日核算", "2"]]);
  const actions = workspace.querySelectorAll("button").map(button => button.textContent);
  expect(actions.filter(label => label === "查看全部")).toHaveLength(3);
  expect(actions).toContain("处理订单"); expect(actions).toContain("审核退款"); expect(actions).toContain("确认打款");
}

const detailView = () => ({id: "ord-collapse-001", paymentStatus: "paid", collectionMode: "platform_collect", deliveryMode: "auto_recharge",
  supplyAmount: "638.00", saleAmount: "700.00", ordinaryRefunded: "10.00", priceAdjustmentRefunded: "0.00", margin: "52.00",
  refundableAmount: "690.00", canResolveRecharge: false, canRefundCustomer: false, canRecordExternalRefund: false,
  canPriceAdjust: false, canRecordManualCompletion: false, canApplyInvoice: false,
  timeline: {createdAt: "2026-10-02T01:00:00Z", paidAt: "2026-10-02T01:01:00Z", fulfillmentStatus: "failed"},
  trace: {merchantOrderNo: "merchant-order-001", upstreamCdkId: "supplier-cdk-id", upstreamCdkCode: "INTERNAL-CDK-SECRET"},
  payment: {provider: "alipay_page", providerRef: "ALIPAY-PAYMENT-001", receivedAmount: "700.00", paidAt: "2026-10-02T01:01:00Z"},
  costAccounting: {version: 1, status: "pending_review", refundBenchmarkUsd: "92.98", actualUsd: null,
    additionalFeesUsd: "0.00", payoutState: "pending_review"},
  invoiceApplication: {id: "invoice-001", orderId: "ord-collapse-001", status: "submitted", version: 1, requiresReview: false,
    invoiceTitle: "测试公司", taxId: "91310000MA12345678", category: "技术服务费", invoiceAmount: "700.00", feeAmount: "35.00",
    recipientEmail: "finance@example.com", contactName: "测试人员"},
  fulfillments: [{id: "task-001", attemptNo: 1, status: "failed", failureCode: "credential_invalid", message: "资料需重新核对",
    upstreamOrderId: "UPSTREAM-ORDER-001", createdAt: "2026-10-02T01:02:00Z", finishedAt: "2026-10-02T01:03:00Z"}],
  refunds: [{id: "refund-001", type: "partial", amount: "10.00", status: "succeeded", providerRefundNo: "REFUND-PROOF-001",
    createdAt: "2026-10-02T01:04:00Z", refundedAt: "2026-10-02T01:05:00Z"}],
});
const manualCompletion = {completedAt: "2026-10-02T02:00:00Z", registeredAt: "2026-10-02T02:10:00Z",
  externalOrderRef: "MANUAL-EXTERNAL-001", evidence: "已核对真实完成流水凭证", reason: "自动失败后已人工完成", actorId: "admin"};

function mountOrderDetail<T extends {id: string}>(h: any, page: UiNode, view: T) {
  const dialog = new UiNode("dialog"), detail = new UiNode("div");
  dialog.className = "workspace-modal order-detail-modal"; dialog.dataset.orderId = view.id;
  detail.className = "modal-body"; dialog.append(detail); page.append(dialog); dialog.showModal();
  h.renderOrderDetailContent(dialog, detail, view);
  return {dialog, detail};
}
function detailPanel(detail: UiNode, title: string) {
  const panel = detail.querySelectorAll("details").find(node => node.querySelector("summary")?.textContent === title);
  expect(panel, "订单详情应保留分区：" + title).toBeDefined();
  return panel!;
}

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

  it("places today's collection metrics ahead of operational queues in the real overview without changing actions or totals", async () => {
    const fetcher = overviewFetch(), {h} = harness(fetcher as typeof fetch);
    const nodes: UiNode[] = (await h.platformOverview({fresh: true})).filter(Boolean);
    const finance = nodes.find(node => node.classList.contains("business-layer"))!;
    const operations = nodes.find(node => node.classList.contains("operations-workspace"))!;
    expect(finance).toBeDefined(); expect(operations).toBeDefined();
    expect(nodes.indexOf(finance)).toBeLessThan(nodes.indexOf(operations));
    expect(finance.querySelectorAll(".stat-chip-label").map(node => node.textContent))
      .toEqual(["今日收款", "今日净流入", "今日退款", "代理佣金", "今日已付", "履约成功"]);
    expect(finance.querySelectorAll("strong").map(node => node.textContent))
      .toEqual(["¥6348.00", "¥6103.00", "¥245.00", "¥713.00", "21", "19"]);
    expect(finance.querySelectorAll("button")).toHaveLength(6);
    expect(finance.textContent).toContain("北京时间 2026-10-02");
    expectOverviewActions(operations); expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("does not fabricate zero income when the finance request initially fails and keeps operational actions available", async () => {
    const {h} = harness(overviewFetch(() => true) as typeof fetch);
    const nodes: UiNode[] = (await h.platformOverview({fresh: true})).filter(Boolean);
    const error = nodes.find(node => node.classList.contains("overview-module-errors"))!;
    expect(error.textContent).toContain("经营数据：核算接口暂不可用");
    const finance = nodes.find(node => node.classList.contains("business-layer"));
    expect(finance?.querySelectorAll(".stat-chip") ?? []).toHaveLength(0);
    expect(nodes.map(node => node.textContent).join("")).not.toContain("系统正常");
    expectOverviewActions(nodes.find(node => node.classList.contains("operations-workspace"))!);
  });

  it("retains last successful financial figures at the top and marks them stale when a later refresh fails", async () => {
    let fail = false;
    const fetcher = overviewFetch(() => fail), {h} = harness(fetcher as typeof fetch);
    await h.platformOverview({fresh: true}); fail = true;
    const nodes: UiNode[] = (await h.platformOverview({fresh: true})).filter(Boolean);
    const finance = nodes.find(node => node.classList.contains("business-layer"))!;
    const operations = nodes.find(node => node.classList.contains("operations-workspace"))!;
    expect(nodes.indexOf(finance)).toBeLessThan(nodes.indexOf(operations));
    expect(finance.querySelectorAll("strong")[0]!.textContent).toBe("¥6348.00");
    const header = nodes.find(node => node.classList.contains("operations-heading"))!;
    expect(header.querySelector(".overview-freshness")!.getAttribute("data-state")).toBe("stale");
    expect(header.textContent).toContain("部分数据已过期");
    expect(nodes.find(node => node.classList.contains("overview-module-errors"))!.textContent).toContain("保留旧值");
    expectOverviewActions(operations); expect(fetcher).toHaveBeenCalledTimes(8);
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

  it("renders order evidence, finance and existing invoice/history as native collapsed sections without discarding records", () => {
    const fetcher = vi.fn(), {h, body} = harness(fetcher as unknown as typeof fetch);
    const {detail} = mountOrderDetail(h, body, {...detailView(), completionSource: "manual", manualCompletion});
    const titles = ["代理分佣", "开票申请", "成本核算", "补差退款", "订单标识与收款凭证", "履约记录与上游单号",
      "历史退款与凭证（与差价退款分开列示）", "人工完成记录", "人工操作审计", "人工审核与订单动作"];
    for (const title of titles) {
      const panel = detailPanel(detail, title);
      expect(panel.open, title + " should initially be collapsed").toBe(false);
      expect(panel.querySelector("summary")).not.toBeNull();
    }
    expect(detail.textContent).toContain("¥638.00"); expect(detail.textContent).toContain("92.98");
    expect(detail.textContent).toContain("ALIPAY-PAYMENT-001"); expect(detail.textContent).toContain("UPSTREAM-ORDER-001");
    expect(detail.textContent).toContain("REFUND-PROOF-001"); expect(detail.textContent).toContain("MANUAL-EXTERNAL-001");
    expect(detail.textContent).toContain("技术服务费"); expect(detail.textContent).toContain("不得按零成本计算");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["canResolveRecharge", "canRefundCustomer", "canRecordExternalRefund", "canPriceAdjust", "canRecordManualCompletion"])(
    "keeps actionable %s available before the collapsed financial sections", permission => {
      const {h, body} = harness(vi.fn() as unknown as typeof fetch);
      const {detail} = mountOrderDetail(h, body, {...detailView(), [permission]: true});
      const action = detailPanel(detail, "人工审核与订单动作"), finance = detailPanel(detail, "代理分佣");
      expect(action.open).toBe(true); expect(action.querySelectorAll("button").length).toBeGreaterThan(0);
      expect(detail.children.indexOf(action)).toBeLessThan(detail.children.indexOf(finance));
      expect(detail.children.indexOf(detail.querySelector(".order-timeline")!)).toBeLessThan(detail.children.indexOf(action));
      expect(finance.open).toBe(false);
    });

  it("preserves user-expanded and user-collapsed sections, including the manual wrapper, across changed server data", () => {
    const {h, body} = harness(vi.fn() as unknown as typeof fetch), view = {...detailView(), canPriceAdjust: true,
      completionSource: "manual", manualCompletion};
    const {dialog, detail} = mountOrderDetail(h, body, view);
    detailPanel(detail, "代理分佣").open = true;
    detailPanel(detail, "订单标识与收款凭证").open = true;
    detailPanel(detail, "人工完成记录").open = true;
    detailPanel(detail, "人工审核与订单动作").open = false;
    detail.scrollTop = 137;
    const updated = {...view, costAccounting: {...view.costAccounting, version: 2}};
    h.renderOrderDetailContent(dialog, detail, updated);
    expect(detailPanel(detail, "代理分佣").open).toBe(true);
    expect(detailPanel(detail, "订单标识与收款凭证").open).toBe(true);
    expect(detailPanel(detail, "人工完成记录").open).toBe(true);
    expect(detailPanel(detail, "人工审核与订单动作").open).toBe(false);
    expect(detailPanel(detail, "成本核算").open).toBe(false); expect(detail.scrollTop).toBe(137);
    detailPanel(detail, "人工完成记录").open = false;
    detailPanel(detail, "人工审核与订单动作").open = true;
    h.renderOrderDetailContent(dialog, detail, {...updated, costAccounting: {...updated.costAccounting, version: 3}});
    expect(detailPanel(detail, "人工完成记录").open).toBe(false);
    expect(detailPanel(detail, "人工审核与订单动作").open).toBe(true);
    expect(detail.querySelectorAll("[data-manual-completion-record]")).toHaveLength(1);
  });

  it.each(["ord-collapse-001", "ord-collapse-002"])("does not leak expansion choices into a newly opened dialog for %s", orderId => {
    const {h, body} = harness(vi.fn() as unknown as typeof fetch), view = {...detailView(), completionSource: "manual", manualCompletion};
    const first = mountOrderDetail(h, body, view);
    detailPanel(first.detail, "代理分佣").open = true; detailPanel(first.detail, "人工完成记录").open = true;
    first.dialog.close(); first.dialog.remove();
    const next = mountOrderDetail(h, body, {...view, id: orderId});
    expect(detailPanel(next.detail, "代理分佣").open).toBe(false);
    expect(detailPanel(next.detail, "人工完成记录").open).toBe(false);
  });

  it.each(["platform_admin", "agent_owner"])("keeps the refund lock warning outside collapsed sections for %s", role => {
    const {h, body} = harness(vi.fn() as unknown as typeof fetch); h.identity(role);
    const {detail} = mountOrderDetail(h, body, {...detailView(), refundReconciliation: {status: "reviewing",
      reportedAmount: "20.00", recordedAmount: "10.00", snapshotCoveredAmount: "0.00", differenceAmount: "20.00"}});
    const warning = detail.children.find(node => node.tagName !== "details" && node.textContent.includes("新的充值和退款出款"));
    expect(warning).toBeDefined(); expect(warning!.textContent).toContain("已派发任务仍会继续查询结果");
    if (role === "platform_admin") {
      expect(warning!.textContent).toContain("可与渠道快照核对的入账 ¥0.00");
      expect(warning!.textContent).toContain("不能仅凭总额相等解锁");
    }
    expect(detail.children.some(node => node.className === "order-detail-alert")).toBe(true);
    if (role === "agent_owner") {
      expect(detail.textContent).not.toContain("INTERNAL-CDK-SECRET");
      expect(detail.querySelectorAll("summary").some(node => node.textContent === "成本核算")).toBe(false);
    }
  });

  it("does not expose manual completion or refund actions to a read-only operator when folding details", () => {
    const {h, body} = harness(vi.fn() as unknown as typeof fetch); h.identity("platform_auditor", ["orders.read"]);
    const {detail} = mountOrderDetail(h, body, {...detailView(), canRefundCustomer: true, canRecordManualCompletion: true});
    const action = detailPanel(detail, "人工审核与订单动作");
    expect(action.open).toBe(false); expect(action.querySelectorAll("button")).toHaveLength(0);
    expect(detail.textContent).not.toContain("登记人工完成"); expect(detail.textContent).not.toContain("审核退款（支付宝原路退）");
    expect(detail.textContent).toContain("需要财务权限");
  });

  it("renders only Details for an order without delivery actions instead of adding a dash placeholder", () => {
    const {h} = harness(vi.fn() as unknown as typeof fetch);
    for (const order of [{id: "ord1", paymentStatus: "paid", deliveryMode: "auto_recharge", fulfillmentStatus: "succeeded"},
      {id: "ord2", paymentStatus: "pending", deliveryMode: "cdk"}]) {
      expect(h.orderDeliveryCell(order)).toBeNull();
      const cell: UiNode = h.orderActionCell(order);
      expect(cell.textContent).toBe("详情"); expect(cell.querySelector(".cdk-delivery")).toBeNull();
    }
  });

  it("keeps real payment, voucher-copy and eligible recharge controls while removing empty placeholders", () => {
    const {h} = harness(vi.fn() as unknown as typeof fetch);
    const payment: UiNode = h.orderActionCell({id: "ord1", paymentStatus: "pending", payUrl: "/test-payment"});
    expect(payment.textContent).toContain("继续付款"); expect(payment.querySelector("a")!.getAttribute("href")).toBe("https://tibo.test/test-payment");
    const voucher: UiNode = h.orderActionCell({id: "ord2", paymentStatus: "paid", deliveryMode: "cdk", voucherCode: "TEST-CDK-001"});
    expect(voucher.textContent).toContain("复制"); expect(voucher.textContent).toContain("详情");
    h.identity("agent_owner");
    const retry: UiNode = h.orderActionCell({id: "ord3", paymentStatus: "paid", deliveryMode: "auto_recharge", fulfillment: {retryAllowed: true}});
    expect(retry.textContent).toBe("重新提交详情");
    const running: UiNode = h.orderActionCell({id: "ord4", paymentStatus: "paid", deliveryMode: "auto_recharge", fulfillmentStatus: "running"});
    expect(running.textContent).toContain("结果核对中，不可重复提交");
    expect(running.querySelectorAll("button").map(button => button.textContent)).toEqual(["详情"]);
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
