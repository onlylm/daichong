import {runInNewContext} from "node:vm";
import {afterEach,describe,expect,it,vi} from "vitest";
import {workspaceJs} from "../src/operations/workspace-page.js";
function harness(fetcher:typeof fetch){const context:{hooks?:any;[key:string]:unknown}={fetch:fetcher,AbortController,setTimeout,clearTimeout,URL,URLSearchParams,location:{origin:"https://tibo.test",hostname:"tibo.test",protocol:"https:",search:""},document:{querySelector:()=>null,addEventListener:()=>{},hidden:false},window:{addEventListener:()=>{}},localStorage:{getItem:()=>null}};
  runInNewContext(workspaceJs.split("\napplyEntryQuery();")[0]+"\nglobalThis.hooks={api,readPage,cache:responseCache,inflight,invalidateCachedPath,identity:(id,tenant)=>{me={id,role:'agent_owner'};merchant=tenant;},detailNeedsLiveSync,detailProgressState,orderDetailRenderMark,paymentStatusLabel,refundStatusLabel,fulfillmentStatusLabel,invoiceStatusLabel,settlementStatusLabel,withdrawalStatusLabel,depositStatusLabel};",context);return context.hooks!;}
const response=(value:unknown)=>({ok:true,status:200,text:async()=>JSON.stringify(value)}) as Response;

// Execute the shipped browser functions with a minimal DOM, not a reimplementation of overview logic.
class TestNode {
  className="";
  dataset:Record<string,string>={};
  children:TestNode[]=[];
  parent:TestNode|null=null;
  attributes=new Map<string,string>();
  listeners=new Map<string,Array<()=>unknown>>();
  constructor(readonly tagName:string,private text=""){}
  get textContent():string{return this.text+this.children.map(child=>child.textContent).join("");}
  set textContent(value:string){this.text=value;this.children=[];}
  get childElementCount(){return this.children.filter(child=>child.tagName!=="#text").length;}
  classList={
    contains:(name:string)=>this.className.split(/\s+/).includes(name),
    add:(name:string)=>{this.classList.toggle(name,true);},
    remove:(name:string)=>{this.classList.toggle(name,false);},
    toggle:(name:string,force?:boolean)=>{const values=new Set(this.className.split(/\s+/).filter(Boolean)),add=force??!values.has(name);if(add)values.add(name);else values.delete(name);this.className=[...values].join(" ");return add;}
  };
  setAttribute(name:string,value:string){if(name==="class")this.className=value;else this.attributes.set(name,value);}
  getAttribute(name:string){return name==="class"?this.className:this.attributes.get(name)??null;}
  removeAttribute(name:string){this.attributes.delete(name);}
  append(...children:TestNode[]){for(const child of children){child.remove();child.parent=this;this.children.push(child);}}
  replaceChildren(...children:TestNode[]){for(const child of this.children)child.parent=null;this.children=[];this.text="";this.append(...children);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null;}
  addEventListener(name:string,listener:()=>unknown){this.listeners.set(name,[...(this.listeners.get(name)||[]),listener]);}
  async click(){for(const listener of this.listeners.get("click")||[])await listener();}
  querySelectorAll(selector:string):TestNode[]{
    const matches=(node:TestNode)=>selector.startsWith("#")?node.getAttribute("id")===selector.slice(1):selector.startsWith(".")?node.classList.contains(selector.slice(1)):node.tagName===selector;
    return this.children.flatMap(child=>[...(matches(child)?[child]:[]),...child.querySelectorAll(selector)]);
  }
  querySelector(selector:string){return this.querySelectorAll(selector)[0]??null;}
}
function overviewHarness(fetcher:typeof fetch,{topbar=false}={}){
  const body=new TestNode("body"),app=new TestNode("div"),content=new TestNode("main"),notice=new TestNode("div"),toolbar=new TestNode("div");
  app.setAttribute("id","app");content.setAttribute("id","content");notice.setAttribute("id","notice");toolbar.setAttribute("id","topbar-toolbar");
  body.append(app,notice);app.append(content);if(topbar)app.append(toolbar);
  const listeners=new Map<string,Array<()=>void>>(),document={hidden:false,body,querySelector:(selector:string)=>body.querySelector(selector),createElement:(tag:string)=>new TestNode(tag),createTextNode:(text:string)=>new TestNode("#text",text),addEventListener:(name:string,listener:()=>void)=>listeners.set(name,[...(listeners.get(name)||[]),listener])};
  const context:{hooks?:any;[key:string]:unknown}={fetch:fetcher,Node:TestNode,AbortController,setTimeout,clearTimeout,URL,URLSearchParams,Date,document,location:{origin:"https://tibo.test",hostname:"tibo.test",protocol:"https:",search:""},window:{addEventListener:()=>{}},localStorage:{getItem:()=>null}};
  // Skip only auto-login; retain appended paymentSettings so render uses its real route table.
  const source=workspaceJs.split("\n").filter(line=>!line.startsWith("applyEntryQuery();")&&!line.startsWith('api("/auth/config")')&&!line.startsWith('api("/auth/me")')).join("\n");
  runInNewContext(source+"\nglobalThis.hooks={render,refreshOverview,stopOverviewPolling,hydrateTopbarWallet,cache:responseCache,get snapshot(){return overviewSnapshot;},clearViewCache:()=>viewLoadedAt.clear(),setTab:name=>{tab=name;},identity:(role='platform_admin',tenant='',user='test-admin')=>{me={id:user,role};merchant=tenant;perms=['wallet.read'];}};",context);
  context.hooks.identity();
  return {h:context.hooks,document,content,toolbar,emit:(name:string)=>{for(const listener of listeners.get(name)||[])listener();}};
}
const financeResponse=(amount:string)=>response({data:{today:{day:"2026-10-02",paidOrders:2,saleAmount:amount,netSaleAmount:amount,refundedAmount:"5.00",succeededOrders:1,marginAmount:"25.00"}}});
const actionResponse=()=>response({data:{counts:{},worker:{status:"healthy"},checks:{},moduleStatus:{}}});
const walletResponse=(procurement="135.00",earnings="25.00")=>response({data:{procurementAvailable:procurement,earningsAvailable:earnings}});

describe("real topbar balance refresh behavior",()=>{
  afterEach(()=>vi.useRealTimers());
  it("makes forced page refresh bypass both the ten-second throttle and GET cache",async()=>{
    vi.useFakeTimers();let amount="135.00";
    const fetcher=vi.fn(async()=>walletResponse(amount)),{h,toolbar}=overviewHarness(fetcher as typeof fetch,{topbar:true});h.identity("agent_owner","m1");
    try{
      await h.render();await vi.advanceTimersByTimeAsync(0);expect(toolbar.textContent).toContain("¥135.00");
      amount="250.00";await h.render({force:true});await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(2);expect(toolbar.textContent).toContain("¥250.00");expect(toolbar.getAttribute("data-state")).toBe("fresh");
    }finally{h.stopOverviewPolling();}
  });
  it("retains nonzero balances with a visible stale label on failure, then clears it only after success",async()=>{
    vi.useFakeTimers();let fail=false;
    const fetcher=vi.fn(async()=>{if(fail)throw new Error("offline");return walletResponse();}),{h,toolbar}=overviewHarness(fetcher as typeof fetch,{topbar:true});h.identity("agent_owner","m1");
    await h.hydrateTopbarWallet();vi.setSystemTime(Date.now()+11000);fail=true;await h.hydrateTopbarWallet();
    expect(toolbar.textContent).toContain("¥135.00");expect(toolbar.textContent).toContain("¥25.00");expect(toolbar.textContent).toContain("余额已过期");expect(toolbar.getAttribute("data-state")).toBe("stale");
    await h.hydrateTopbarWallet();expect(toolbar.getAttribute("data-state")).toBe("stale");
    fail=false;await h.hydrateTopbarWallet();expect(toolbar.getAttribute("data-state")).toBe("fresh");expect(toolbar.textContent).not.toContain("余额已过期");
  });
  it.each(["tenant","identity"])("rejects an older %s wallet response after the current balance is displayed",async kind=>{
    const pending:Array<(response:Response)=>void>=[],fetcher=vi.fn(()=>new Promise<Response>(resolve=>pending.push(resolve))),{h,toolbar}=overviewHarness(fetcher as typeof fetch,{topbar:true});h.identity("agent_owner","m1","user-1");
    const old=h.hydrateTopbarWallet();h.identity("agent_owner",kind==="tenant"?"m2":"m1",kind==="identity"?"user-2":"user-1");const current=h.hydrateTopbarWallet();
    pending[1]!(walletResponse("250.00","40.00"));await current;pending[0]!(walletResponse());await old;
    expect(toolbar.textContent).toContain("¥250.00");expect(toolbar.textContent).toContain("¥40.00");expect(toolbar.textContent).not.toContain("¥135.00");
  });
  it("does not publish a cancelled wallet request even if the transport finishes later",async()=>{
    let resolve!:(response:Response)=>void;const fetcher=vi.fn(()=>new Promise<Response>(done=>resolve=done)),{h,toolbar}=overviewHarness(fetcher as typeof fetch,{topbar:true});h.identity("agent_owner","m1");
    const controller=new AbortController(),pending=h.hydrateTopbarWallet({signal:controller.signal});controller.abort();resolve(walletResponse());await pending;
    expect(toolbar.textContent).not.toContain("¥135.00");expect(toolbar.getAttribute("data-state")).not.toBe("fresh");
  });
});

describe("real homepage refresh behavior",()=>{
  afterEach(()=>vi.useRealTimers());
  it("keeps the latest nonzero receipts through force, failure and a subsequent cached render",async()=>{
    vi.useFakeTimers();let amount="135.00",fail=false;
    const fetcher=vi.fn(async(url:string)=>{if(url.includes("/finance/summary")){if(fail)throw new Error("offline");return financeResponse(amount);}return actionResponse();});
    const {h,content}=overviewHarness(fetcher as typeof fetch);
    try{
      await h.render();expect(content.textContent).toContain("¥135.00");
      amount="250.00";
      const refresh=content.querySelectorAll("button").find(button=>button.textContent==="刷新总览")!;
      await refresh.click();expect(content.textContent).toContain("¥250.00");expect(fetcher).toHaveBeenCalledTimes(4);
      fail=true;await h.refreshOverview();
      expect(content.textContent).toContain("¥250.00");expect(content.textContent).not.toContain("¥135.00");
      expect(content.querySelector(".overview-freshness")?.getAttribute("data-state")).toBe("stale");
      expect(content.querySelector(".overview-module-errors")?.textContent).toContain("经营数据：offline（保留旧值）");
      h.clearViewCache();await h.render();
      expect(content.textContent).toContain("¥250.00");expect(content.textContent).not.toContain("¥135.00");expect(fetcher).toHaveBeenCalledTimes(6);
    }finally{h.stopOverviewPolling();}
  });
  it("ignores an older response even when the transport resolves after abort",async()=>{
    vi.useFakeTimers();const pending:Array<{url:string;resolve:(response:Response)=>void;signal:AbortSignal}>=[];
    const fetcher=vi.fn((url:string,opts:RequestInit)=>new Promise<Response>(resolve=>pending.push({url,resolve,signal:opts.signal as AbortSignal}))),{h,content}=overviewHarness(fetcher as typeof fetch);
    try{
      const old=h.render({force:true});expect(pending).toHaveLength(2);
      const current=h.render({force:true});expect(pending).toHaveLength(4);expect(pending[0]!.signal.aborted).toBe(true);
      for(const request of pending.slice(2))request.resolve(request.url.includes("finance")?financeResponse("250.00"):actionResponse());
      await current;
      for(const request of pending.slice(0,2))request.resolve(request.url.includes("finance")?financeResponse("135.00"):actionResponse());
      await old;
      expect(content.textContent).toContain("¥250.00");expect(content.textContent).not.toContain("¥135.00");
      expect(h.snapshot.modules.finance.data.today.saleAmount).toBe("250.00");
      expect(h.cache.size).toBe(2);
      h.clearViewCache();await h.render();expect(fetcher).toHaveBeenCalledTimes(4);expect(content.textContent).toContain("¥250.00");
    }finally{h.stopOverviewPolling();}
  });
  it("does not repaint or cache an aborted overview after leaving the page",async()=>{
    vi.useFakeTimers();const pending:Array<{url:string;resolve:(response:Response)=>void}>=[];
    const fetcher=vi.fn((url:string)=>new Promise<Response>(resolve=>pending.push({url,resolve}))),{h,content}=overviewHarness(fetcher as typeof fetch);
    try{
      const old=h.render();h.setTab("docs");await h.render();const visible=content.querySelector("#view-docs")!;
      expect(visible.textContent).toContain("开发者中心");expect(visible.classList.contains("hidden")).toBe(false);
      for(const request of pending)request.resolve(request.url.includes("finance")?financeResponse("135.00"):actionResponse());
      await old;await Promise.resolve();await Promise.resolve();
      expect(visible.textContent).not.toContain("¥135.00");expect(h.snapshot.modules).toEqual({});expect(h.cache.size).toBe(0);
    }finally{h.stopOverviewPolling();}
  });
  it("stops polling while hidden and performs a network refresh when visible again",async()=>{
    vi.useFakeTimers();const fetcher=vi.fn(async(url:string)=>url.includes("finance")?financeResponse("135.00"):actionResponse()),{h,document,emit,content}=overviewHarness(fetcher as typeof fetch);
    try{
      await h.render();expect(fetcher).toHaveBeenCalledTimes(2);document.hidden=true;emit("visibilitychange");
      await vi.advanceTimersByTimeAsync(90000);await h.refreshOverview();expect(fetcher).toHaveBeenCalledTimes(2);
      document.hidden=false;emit("visibilitychange");await vi.advanceTimersByTimeAsync(0);expect(fetcher).toHaveBeenCalledTimes(4);
      expect(content.textContent).toContain("¥135.00");
      await vi.advanceTimersByTimeAsync(30000);expect(fetcher).toHaveBeenCalledTimes(6);
    }finally{h.stopOverviewPolling();}
  });
});

describe("workspace request and progress plumbing",()=>{
  it("deduplicates live reads and does not let one aborted view cancel the other reader",async()=>{let resolve!:(v:Response)=>void;const fetcher=vi.fn(()=>new Promise<Response>(r=>resolve=r)),h=harness(fetcher as typeof fetch);h.identity("a","m1");const controller=new AbortController(),first=h.api("/orders","GET",undefined,{signal:controller.signal}),rejected=expect(first).rejects.toMatchObject({name:"AbortError"}),second=h.api("/orders");controller.abort();await rejected;const third=h.api("/orders");expect(fetcher).toHaveBeenCalledTimes(1);resolve(response({data:[]}));await Promise.all([second,third]);expect(h.inflight.size).toBe(0);});
  it("retains metadata after a GET, invalidates after writes, and isolates cache by identity and tenant",async()=>{const fetcher=vi.fn(async()=>response({data:[]})),h=harness(fetcher as typeof fetch);h.identity("a","m1");await h.api("/agents");await h.api("/orders");await h.api("/agents");expect(fetcher).toHaveBeenCalledTimes(2);h.identity("a","m2");await h.api("/agents");h.identity("b","m2");await h.api("/agents");expect(fetcher).toHaveBeenCalledTimes(4);await h.api("/agents","PUT",{});await h.api("/agents");expect(fetcher).toHaveBeenCalledTimes(6);});
  it("does not repopulate stale cache after an intervening write",async()=>{let resolve!:(v:Response)=>void;const fetcher=vi.fn((url:string)=>url.endsWith("/agents")?new Promise<Response>(r=>resolve=r):Promise.resolve(response({}))),h=harness(fetcher as typeof fetch);const p=h.api("/agents");await h.api("/products/x","PUT",{});resolve(response({data:["stale"]}));await p;expect(h.cache.size).toBe(0);});
  it("forces a fresh homepage read, fixes path invalidation, and retains the last good cache after failure",async()=>{let fail=false,calls=0;const fetcher=vi.fn(async()=>{calls++;if(fail)throw new Error("offline");return response({data:{revision:calls}});}),h=harness(fetcher as typeof fetch);h.identity("admin","platform");const first=await h.api("/action-center");expect(first.data.revision).toBe(1);expect((await h.api("/action-center")).data.revision).toBe(1);expect(calls).toBe(1);expect((await h.api("/action-center","GET",undefined,{fresh:true})).data.revision).toBe(2);expect(calls).toBe(2);fail=true;await expect(h.api("/action-center","GET",undefined,{fresh:true})).rejects.toThrow("offline");expect((await h.api("/action-center")).data.revision).toBe(2);h.invalidateCachedPath("/action-center");expect(h.cache.size).toBe(0);});
  it("starts a new network request for fresh reads and rejects late cache ownership",async()=>{
    const pending:Array<(value:Response)=>void>=[],fetcher=vi.fn(()=>new Promise<Response>(resolve=>pending.push(resolve))),h=harness(fetcher as typeof fetch);
    const old=h.api("/wallets/m1"),fresh=h.api("/wallets/m1","GET",undefined,{fresh:true});
    const calls=fetcher.mock.calls.length;
    pending[1]?.(response({data:{procurementAvailable:"250.00",earningsAvailable:"40.00"}}));
    pending[0]!(response({data:{procurementAvailable:"135.00",earningsAvailable:"25.00"}}));
    await Promise.all([old,fresh]);
    expect(calls).toBe(2);
    expect((await h.api("/wallets/m1")).data).toEqual({procurementAvailable:"250.00",earningsAvailable:"40.00"});
  });
  it("does not join a read from before an intervening mutation",async()=>{
    const pending:Array<(value:Response)=>void>=[],fetcher=vi.fn((url:string)=>url.endsWith("/agents")?new Promise<Response>(resolve=>pending.push(resolve)):Promise.resolve(response({}))),h=harness(fetcher as typeof fetch);
    const old=h.api("/agents");await h.api("/products/x","PUT",{});const current=h.api("/agents"),calls=fetcher.mock.calls.length;
    pending[1]?.(response({data:["current"]}));pending[0]!(response({data:["old"]}));await Promise.all([old,current]);
    expect(calls).toBe(3);expect((await h.api("/agents")).data).toEqual(["current"]);
  });
  it("carries forced refresh and cancellation through the overview page reader",async()=>{const fetcher=vi.fn(async()=>response({data:{ok:true}})),h=harness(fetcher as typeof fetch);h.identity("admin","platform");await h.readPage("/action-center");await h.readPage("/action-center");expect(fetcher).toHaveBeenCalledTimes(1);const controller=new AbortController();await h.readPage("/action-center",{fresh:true,signal:controller.signal});expect(fetcher).toHaveBeenCalledTimes(2);expect(workspaceJs).toContain("if(platform())return platformOverview(opts)");expect(workspaceJs).toContain('readPage("/announcements",opts)');});
  it("guards overview state from late navigation responses and pauses polling while hidden",()=>{expect(workspaceJs).toContain("sequence!==overviewRequestSequence");expect(workspaceJs).toContain("opts.signal?.aborted");expect(workspaceJs).toContain('if(document.hidden)stopOverviewPolling();else refreshOverview()');expect(workspaceJs).toContain("overviewRefreshInFlight");});
  it("keeps terminal dialogs quiet but refreshes pending payment and in-flight recharge",()=>{const h=harness(vi.fn() as unknown as typeof fetch);expect(h.detailNeedsLiveSync({paymentStatus:"pending"})).toBe(true);expect(h.detailNeedsLiveSync({paymentStatus:"paid",timeline:{fulfillmentStatus:"running"}})).toBe(true);expect(h.detailNeedsLiveSync({paymentStatus:"paid",deliveryMode:"cdk",voucherCode:"test",timeline:{fulfillmentStatus:"succeeded"}})).toBe(false);});
  it("repaints order details when invoice, payment evidence or action permissions change",()=>{const h=harness(vi.fn() as unknown as typeof fetch),base={paymentStatus:"paid",payment:{provider:"alipay_page",providerRef:"trade-1",receivedAmount:"110.00",paidAt:"2026-10-01T10:00:00.000Z"},invoiceApplication:{id:"inv-1",status:"submitted",version:1},timeline:{fulfillmentStatus:"succeeded"},fulfillments:[],refunds:[],canRefundCustomer:true};const mark=h.orderDetailRenderMark(base);expect(h.orderDetailRenderMark({...base,invoiceApplication:{...base.invoiceApplication,status:"processing",version:2}})).not.toBe(mark);expect(h.orderDetailRenderMark({...base,payment:{...base.payment,providerRef:"trade-2"}})).not.toBe(mark);expect(h.orderDetailRenderMark({...base,canRefundCustomer:false})).not.toBe(mark);});
  it("never marks a queued or running recharge as completed and shows the published stage",()=>{const h=harness(vi.fn() as unknown as typeof fetch);expect(h.detailProgressState({timeline:{fulfillmentStatus:"queued"},fulfillment:{progress_stage:"queued"}})).toMatchObject({done:false,failed:false,label:"排队中"});expect(h.detailProgressState({timeline:{fulfillmentStatus:"running"},fulfillment:{progress_stage:"logging_in"}})).toMatchObject({done:false,label:"正在登录"});expect(h.detailProgressState({timeline:{fulfillmentStatus:"failed"},fulfillment:{progress_stage:"failed"}})).toMatchObject({done:true,failed:true,label:"充值失败"});});
  it("distinguishes an evidenced manual completion from earlier automatic failures",()=>{const h=harness(vi.fn() as unknown as typeof fetch);
    expect(h.detailProgressState({completionSource:"manual",timeline:{fulfillmentStatus:"succeeded"}})).toMatchObject({done:true,failed:false,label:"已完成（人工）"});
    expect(workspaceJs).toContain('button("登记人工完成"');expect(workspaceJs).toContain('orderDetailPanel("人工完成记录"');
    expect(workspaceJs).toContain('"自动尝试 "+task.attemptNo');expect(workspaceJs).toContain('"后台登记"');
    expect(workspaceJs).toContain('待核算（不得按零成本计算）');
  });
  it("keeps payment, refund, fulfillment, invoice and settlement copy domain-specific",()=>{const h=harness(vi.fn() as unknown as typeof fetch);expect(h.paymentStatusLabel("paid")).toBe("已支付");expect(h.refundStatusLabel("processing")).toBe("退款处理中");expect(h.fulfillmentStatusLabel("succeeded")).toBe("充值成功");expect(h.invoiceStatusLabel("processing")).toBe("开票处理中");expect(h.settlementStatusLabel("paid")).toBe("已登记打款");expect(h.withdrawalStatusLabel("approved")).toBe("待打款");expect(h.depositStatusLabel("requested")).toBe("待支付");expect(workspaceJs).toContain("paymentTag(order.paymentStatus)");expect(workspaceJs).toContain("refundTag(r.status)");expect(workspaceJs).toContain("invoiceTag(value.status)");expect(workspaceJs).toContain("settlementTag(x.status)");expect(workspaceJs).not.toContain('v==="processing"?"开票中"');});
  it("surfaces duplicate invoice payments as an actionable, manually verified finance exception",()=>{
    expect(workspaceJs).toContain('"补差重复到账",counts.invoicePaymentReviews');
    expect(workspaceJs).toContain('button("核对两笔流水",()=>openInvoicePaymentReview(value)');
    expect(workspaceJs).toContain('function invoicePaymentReviewRows(items)');
    expect(workspaceJs).toContain('class:"invoice-payment-pair"');
    expect(workspaceJs).toContain('value.status==="reviewing"&&me.role==="platform_admin"');
    expect(workspaceJs).toContain('/invoice-payment-reconciliations/"+id(value.id)+"/record-refund');
    expect(workspaceJs).toContain('这里只登记结果，不发起退款');
    expect(workspaceJs).toContain('merchantId="+id(merchant)+"&status=reviewing');
    expect(workspaceJs).toContain('wantsReview?api("/invoice-payment-reconciliations');
    expect(workspaceJs).toContain('catch(error=>({data:null,error}))');
    expect(workspaceJs).toContain('不代表没有待核对事项');
  });
  it("uses shared native dialogs and actionable payment configuration rather than blocking native prompts",()=>{expect(workspaceJs).not.toMatch(/\b(?:prompt|confirm)\(/);expect(workspaceJs).toContain('function confirmAction(');expect(workspaceJs).toContain('button("配置与启用"');expect(workspaceJs).toContain('workspaceHeading("支付设置"');expect(workspaceJs).toContain('button("订单详情"');expect(workspaceJs).toContain('按上游订单查美元成本');});
  it("keeps orders refreshable without replacing current content",()=>{expect(workspaceJs).toContain('button("刷新订单"');expect(workspaceJs).toContain('保留当前订单');expect(workspaceJs).toContain('orders?.some(orderNeedsLiveSync)?3000:30000');expect(workspaceJs).toContain('window.addEventListener("online"');});
  it("shows the verified account current plan and target package before workspace recharge",()=>{expect(workspaceJs).toContain('class:"recharge-plan-compare"');expect(workspaceJs).toContain('value.data.current_plan');expect(workspaceJs).toContain('value.data.product_name||planName(value.data.target_plan)');expect(workspaceJs).toContain('正在核对账号与当前套餐');});
  it("uses four-character role navigation with shareable browser history",()=>{expect(workspaceJs).toContain('["overview","平台总览"');expect(workspaceJs).toContain('["notifications","待办中心"');expect(workspaceJs).toContain('["apiAccess","开放接口"');expect(workspaceJs).toContain('["overview","业务总览"');expect(workspaceJs).toContain('function viewHref(name)');expect(workspaceJs).toContain('window.addEventListener("popstate"');expect(workspaceJs).toContain('aria-current');});
  it("lets agents and administrators stage and enable per-application IP allowlists",()=>{expect(workspaceJs).toContain('function openIpAllowlistModal(app)');expect(workspaceJs).toContain('"兼容开放（暂不限制来源 IP）"');expect(workspaceJs).toContain('"强制白名单（仅允许下列来源）"');expect(workspaceJs).toContain('"/api-access/ip-allowlist"');expect(workspaceJs).toContain('button("IP 白名单"');});
  it("opens order details in the responsive workspace drawer and exposes refunded orders",()=>{expect(workspaceJs).toContain('workspace-modal workspace-drawer order-detail-modal');expect(workspaceJs).toContain('["refunded","已退款"]');expect(workspaceJs).toContain('class:"orders-surface"');});
  it("loads order audit history only when the collapsed trace panel is opened",()=>{expect(workspaceJs).toContain('title==="人工操作审计"');expect(workspaceJs).toContain('/audit?page=');expect(workspaceJs).toContain('展开后按订单读取审计记录');expect(workspaceJs).toContain('订单审计分页');});
  it("turns tasks and support tickets into actionable drawer workflows",()=>{expect(workspaceJs).toContain('class:"section task-workspace"');expect(workspaceJs).toContain('button("订单详情"');expect(workspaceJs).toContain('workspace-modal workspace-drawer ticket-detail-drawer');expect(workspaceJs).toContain('workspaceHeading("工单售后"');});
  it("uses deep-linked finance workspaces with a dedicated commission ledger",()=>{expect(workspaceJs).toContain('["reconcile","平台对账"');expect(workspaceJs).toContain('["refunds","退款审核"');expect(workspaceJs).toContain('["costs","成本补差"');expect(workspaceJs).toContain('["agents","代理钱包"');expect(workspaceJs).toContain('["commissions","佣金流水"');expect(workspaceJs).toContain('["settlements","每日核算"');expect(workspaceJs).toContain('function financeHref(panel)');expect(workspaceJs).toContain('scope="+entryScope');});
  it("provides a global withdrawal queue outside support tickets",()=>{expect(workspaceJs).toContain('["withdrawals","提现审核"');expect(workspaceJs).toContain('async function withdrawalFinancePage()');expect(workspaceJs).toContain('?"审核提现":"确认打款"');expect(workspaceJs).toContain('资金钱包的「提现申请」查看进度');expect(workspaceJs).not.toContain('可在工单中跟踪');});
  it("uses server capabilities and concrete refund ids for homepage actions",()=>{expect(workspaceJs).toContain('function actionRefundButton(refund,allowed)');expect(workspaceJs).toContain('completePriceAdjustmentRefund(refund):completeCustomerRefund(refund)');expect(workspaceJs).toContain('capabilities.canManageSettlements');expect(workspaceJs).toContain('capabilities.canReviewWithdrawals');expect(workspaceJs).not.toContain('button("处理退款",()=>openOrderDetailModal');});
  it("preserves created and paid date filters when refreshing or entering from dashboard metrics",()=>{expect(workspaceJs).toContain('orderCreatedFrom="", orderCreatedTo="", orderPaidFrom="", orderPaidTo=""');expect(workspaceJs).toContain('qs.set("createdFrom",orderCreatedFrom)');expect(workspaceJs).toContain('qs.set("paidTo",orderPaidTo)');expect(workspaceJs).toContain('input(name,label,"date",value)');expect(workspaceJs).toContain('openOrdersWithFilters({paidFrom:today.day,paidTo:today.day})');expect(workspaceJs).toContain('openOrdersWithFilters({status:"succeeded",paidFrom:today.day,paidTo:today.day})');});
  it("presents the four managed subscription products as an operational catalogue",()=>{expect(workspaceJs).toContain('workspaceHeading("商品管理"');expect(workspaceJs).toContain('["套餐总数",products.length]');expect(workspaceJs).toContain('"退差基准"');expect(workspaceJs).toContain('button("编辑配置"');expect(workspaceJs).toContain('button("供应检查"');});
  it("opens each agent as a deep-linked management hub",()=>{expect(workspaceJs).toContain('function agentHref(agentId="")');expect(workspaceJs).toContain('syncAgentUrl(agentId)');expect(workspaceJs).toContain('打开一个代理即可管理资料、账号、订单、资金、佣金、API 与合作配置');expect(workspaceJs).toContain('button("全部订单"');expect(workspaceJs).toContain('button("资金佣金"');expect(workspaceJs).toContain('button("API 管理"');expect(workspaceJs).toContain('section("最近订单"');});
  it("loads agent identity and finance panels without avoidable request waterfalls",()=>{expect(workspaceJs).toContain('tierDetailId?api("/agents/"+id(tierDetailId))');expect(workspaceJs).toContain('pendingEarnResult]=await Promise.all');expect(workspaceJs).toContain('finance=walletResult.data');expect(workspaceJs).toContain('异常补登全部');});
  it("uses a compact supplier control workspace with modal secrets",()=>{expect(workspaceJs).toContain('supplierSettings:supplierSettingsV2');expect(workspaceJs).toContain('workspaceHeading("生产供应"');expect(workspaceJs).toContain('openFormModal("编辑供应连接"');expect(workspaceJs).toContain('section("商品映射"');expect(workspaceJs).toContain('section("供应对账"');expect(workspaceJs).toContain('密钥只写不回显');});
  it("turns durable worker health into an actionable Chinese operations view",()=>{expect(workspaceJs).toContain('function openWorkerHealthDetail');expect(workspaceJs).toContain('button("查看详情"');expect(workspaceJs).toContain('"retail-payment":"订单支付"');expect(workspaceJs).toContain('"daily-settlement":"每日核算"');expect(workspaceJs).toContain('不保存或展示上游异常原文');});
  it("keeps configuration pages reachable without duplicating their state on the homepage",()=>{expect(workspaceJs).not.toContain('checkText(checks.payment)');expect(workspaceJs).not.toContain('checkText(checks.upstream)');expect(workspaceJs).toContain('["paymentSettings","支付设置"');expect(workspaceJs).toContain('["supplierSettings","生产供应"');expect(workspaceJs).toContain('button("查看运行",()=>gotoTab("runtimeStatus"))');});
});
