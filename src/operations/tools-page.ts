/** Read-only operational surfaces; reuse workspace controls and permission checks. */
export const workspaceToolsJs = String.raw`
let globalSearchText="",globalSearchKind="all",globalSearchPage=1;
let auditFilters={target:"",action:"",from:"",to:"",merchantId:""},auditPage=1;
function searchResultAction(item,kind){
  if(kind==="wallet")return button("流水详情",()=>{const dialog=openFormModal("资金流水",[el("p",{},"流水编号："+item.id),el("p",{},"关联凭证："+item.title),el("p",{},item.description),el("p",{},"发生时间："+date(item.occurredAt)),button("查看代理钱包",()=>{dialog.close();walletLedgerTab="ledger";walletHistoryPage=1;if(platform())openAgentConfig(item.merchantId,"finance");else gotoTab("wallet");})],"关闭",async()=>true);});
  if(item.orderId)return button("订单详情",()=>openOrderDetailModal({id:item.orderId}),"primary");
  if(item.merchantId&&platform())return button("管理代理",()=>openAgentConfig(item.merchantId,"overview"));
  return el("span",{},"—");
}
async function globalSearch(opts={}){
  const kinds=[["all","全部类型"],["order","订单"],["cdk","平台卡密"]];
  if(can("wallet.read"))kinds.push(["wallet","钱包流水"]);
  if(platform()&&can("agents.read"))kinds.push(["agent","代理名称"]);
  if(platform()&&can("wallet.read"))kinds.push(["payment","支付流水"]);
  const searchForm=form("查询记录",[input("q","订单号、代理名称、流水号或平台 CDK","search",globalSearchText,{required:true,minlength:2,maxlength:120,autocomplete:"off"}),select("kind","记录类型",kinds,globalSearchKind)],"搜索",async d=>{globalSearchText=d.q.trim();globalSearchKind=d.kind;globalSearchPage=1;await render({force:true});});
  const nodes=[workspaceHeading("全局搜索","搜索可访问的业务记录。请勿输入 Session、密码或接口密钥。"),searchForm];
  if(globalSearchText.length<2)return [...nodes,el("p",{class:"empty"},"输入至少两个字符，可按订单号或流水号精确定位，也可用代理名称查找。")];
  const result=(await api("/search?q="+id(globalSearchText)+"&kind="+id(globalSearchKind)+"&page="+globalSearchPage,"GET",undefined,opts)).data;
  nodes.push(el("p",{class:"muted",role:"status"},"共找到 "+result.total+" 条记录；每类每页最多展示 10 条。"));
  for(const group of result.groups){if(!group.meta.total)continue;
    nodes.push(section(group.label+" · "+group.meta.total,table(["记录","说明","时间","操作"],group.data.map(item=>[el("code",{},item.title),item.description,date(item.occurredAt),searchResultAction(item,group.kind)])),paginationBar(group.meta,p=>{globalSearchKind=group.kind;globalSearchPage=p;render({force:true});})));
  }
  if(!result.total)nodes.push(el("p",{class:"empty"},"没有匹配的记录。请检查编号，尝试更短的关键词，或切换记录类型；这里只显示你有权访问的记录。"));
  return nodes;
}
async function auditTrail(opts={}){
  const fields=[input("target","订单或对象编号","text",auditFilters.target),input("action","操作类型关键词","text",auditFilters.action),input("from","开始日期","date",auditFilters.from),input("to","结束日期","date",auditFilters.to),select("merchantId","代理范围",[["","全部（含平台操作）"],...agentCatalog.map(a=>[a.id,a.name])],auditFilters.merchantId)];
  const filters=form("审计筛选",fields,"查询记录",async d=>{auditFilters=d;auditPage=1;await render({force:true});});
  const params=new URLSearchParams({page:String(auditPage),limit:"30"});for(const [key,value]of Object.entries(auditFilters))if(value)params.set(key,value);
  const result=await api("/audit?"+params.toString(),"GET",undefined,opts);
  const rows=(result.data||[]).map(a=>{const actions=[];
    if(a.orderId)actions.push(button("订单详情",()=>openOrderDetailModal({id:a.orderId})));
    else if(a.targetType==="invoice_application"&&can("invoices.read"))actions.push(button("开票详情",()=>openInvoiceDetail({id:a.targetId})));
    if(a.merchantId&&can("agents.read"))actions.push(button("代理详情",()=>openAgentConfig(a.merchantId)));
    actions.push(button("查看记录",()=>openFormModal("审计记录",[el("p",{},"操作："+a.action),el("p",{},"对象："+a.targetType+" / "+a.targetId),el("p",{},"操作人："+a.actorId),el("p",{},"请求号："+a.requestId),el("p",{},"时间："+date(a.createdAt))],"关闭",async()=>true)));
    return [date(a.createdAt),a.action,el("code",{},a.actorId),el("code",{},a.targetId),el("div",{class:"actions"},...actions)];});
  return [workspaceHeading("操作审计","只读追溯已有操作记录；不删除历史，不执行资金操作。"),filters,section("操作记录",rows.length?table(["时间","操作","操作人","业务对象","定位"],rows):el("p",{class:"empty"},"该筛选条件下没有记录，可调整日期或对象编号。"),paginationBar(result.meta,p=>{auditPage=p;render({force:true});}))];
}
async function runtimeStatus(opts={}){
  const data=(await api("/runtime-status","GET",undefined,opts)).data,w=data.worker,b=data.backup;
  const names={healthy:"正常",degraded:"异常",missing:"未检测",stale:"心跳过期",stopped:"已停止"};
  const lanes=w.lanes.map(l=>[l.name,l.inFlight?"执行中":l.consecutiveFailures?"最近失败":"空闲",date(l.lastSucceededAt),date(l.lastFailedAt),String(l.consecutiveFailures)]);
  return [workspaceHeading("运行备份","读取实际运行记录与恢复验证摘要，不代表支付或上游实时连通。",[button("刷新状态",()=>render({force:true}))]),
    el("p",{class:"muted"},"最近成功读取："+date(data.checkedAt)),
    section("后台任务",el("p",{role:"status"},"Worker："+(names[w.status]||"未检测")+" · 最近心跳："+date(w.heartbeatAt)),lanes.length?table(["通道","状态","最近成功","最近失败","连续失败"],lanes):el("p",{class:"empty"},"尚未收到后台任务心跳。"),button("查看详情",()=>openWorkerHealthDetail(w))),
    section("任务积压",el("p",{},"排队或运行中："+data.queue.active+" 笔 · 最早进入："+date(data.queue.oldestAt)),data.queue.oldestOrderId?button("查看最早订单",()=>openOrderDetailModal({id:data.queue.oldestOrderId})):el("p",{class:"muted"},"当前没有排队或运行中的任务。"),button("待办中心",()=>gotoTab("notifications"))),
    section("备份验证",el("p",{role:"status"},b.label),el("p",{},"最近恢复验证："+date(b.checkedAt)),el("p",{class:"muted"},"这是备份恢复演练的脱敏结果，不是实时备份成功证明，也不代表异机灾备已经验证。")),
    el("p",{class:"muted"},data.scope)];
}
`;
