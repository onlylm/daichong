// Extends the existing workspace DOM helpers; no innerHTML or credential persistence in the browser.
export const paymentSettingsJs = String.raw`
async function paymentSettings(){
  const s=(await api("/payment-settings")).data,managed=s.mode==="managed",names={alipay_page:"支付宝 · 当面付",dujiaopay:"USDT · DujiaoPay"};
  const paymentForm=(fields,submit,run)=>{const f=el("form",{class:"form-grid payment-form"},fields),status=el("p",{class:"wide",role:"alert"});f.append(el("div",{class:"actions"},el("button",{class:"primary",type:"submit"},submit)),status);f.addEventListener("submit",async e=>{e.preventDefault();const b=f.querySelector("button[type=submit]");b.disabled=true;status.textContent="";try{await run(Object.fromEntries(new FormData(f)),f);}catch(err){status.className="wide error";status.textContent=err.message;}finally{b.disabled=false;}});return f;};
  const executionLabel=s.executionMode==="production"?"生产执行":s.executionMode==="controlled"?"受控实单":"总开关关闭";
  const helpLines=[s.executionMode==="production"?"系统按生产规则运行；仅已验证且已启用的通道接受新付款。":s.executionMode==="controlled"?"仅白名单代理和限额内订单可执行真实交易。":"可配置并验证通道，部署级总开关打开后才能启用真实收款。",!managed?"当前为"+(s.mode==="mock"?"模拟支付":"文件配置支付宝")+"模式；切换到后台托管后，以下开关才控制真实收款。":null,"关闭通道后不再发起新付款；已打开的支付页或链上地址可能仍有效，已有付款继续核对到账。"].filter(Boolean);
  const channelStatus=c=>s.executionMode==="disabled"?"总开关关闭":!managed?"未由后台控制":c.paused||!c.activeId?"已关闭":"收款中";
  const disable=async channels=>{if(!await confirmAction("确认关闭所选通道？停止新付款，已有订单仍核对到账。"))return;await api("/payment-settings/disable","POST",{channels:channels.map(c=>({channel:c.channel,version:c.version}))});await render();};
  const channelPanels=s.channels.map(c=>{
    const r=c.draft||c.active,d=r?.details||{},retained=r?"（留空保留已保存密钥）":"（首次必填）";
    const fields=c.channel==="alipay_page"?[
      input("appId","支付宝 APPID","text",d.appId||"",{required:true,pattern:"[0-9]{16}"}),
      input("sellerId","收款商户 PID","text",d.sellerId||"",{required:true,pattern:"[0-9]{16}"}),
      select("keyType","应用私钥格式",[["PKCS8","PKCS8"],["PKCS1","PKCS1"]],d.keyType||"PKCS8"),
      input("privateKey","应用私钥 Base64，无头尾 "+retained,"password","",{autocomplete:"new-password",maxlength:16000}),
      input("publicKey","支付宝公钥 Base64 "+retained,"password","",{autocomplete:"new-password",maxlength:16000})
    ]:[
      input("merchantId","DujiaoPay 商户 ID","text",d.merchantId||"",{required:true,maxlength:160}),
      input("projectId","项目 ID","text",d.projectId||"",{required:true,maxlength:160}),
      input("keyId","API Key ID（不是 Key Prefix）","text",d.keyId||"",{required:true,maxlength:160}),
      select("network","收款网络；须先在服务商后台启用",[["","请选择收款网络"],...s.networks.map(x=>[x.value,x.label])],d.network||""),
      input("apiSecret","API Secret "+retained,"password","",{autocomplete:"new-password",maxlength:512}),
      input("webhookSecret","Webhook 回调密钥 "+retained,"password","",{autocomplete:"new-password",maxlength:512})
    ];
    let dialog;const body=el("div",{class:"payment-channel-body"},el("p",{class:"muted"},"凭据加密保存且不回显。空白不会清除旧密钥；切换应用、项目或 Key ID 时须重新填写。"),paymentForm(fields,"保存修改",async(data,f)=>{await api("/payment-settings","PUT",{...data,channel:c.channel,version:c.version});f.reset();dialog?.close();await render({force:true});tell("配置已加密保存为草稿，尚未启用。");}));
    if(r){
      const check=c.draft?.check,validation=check?(check.kind==="local_keys"?"RSA 密钥格式已通过；尚未验证支付宝产品权限或真实到账。":"项目身份验证通过；尚未验证回调连通、收款网络或真实到账。"):"当前草稿尚未验证。";
      const verify=button(c.channel==="alipay_page"?"验证密钥格式":"验证项目身份（只读）",async()=>{await api("/payment-settings/check","POST",{channel:c.channel,version:c.version});dialog?.close();await render({force:true});tell("验证完成；这不代表已完成真实到账测试。再次打开配置即可启用。");});
      const enable=button("启用此配置收款",async()=>{if(!await confirmAction("确认已配置本页回调地址，并启用该通道的真实收款？后续真实付款将进入订单履约流程。"))return;await api("/payment-settings/enable","POST",{channel:c.channel,version:c.version,confirmRealPayments:true,confirmCallbackConfigured:true});dialog?.close();await render({force:true});},"primary");
      verify.disabled=!c.draft;enable.disabled=!managed||!check||s.executionMode==="disabled";
      body.append(el("div",{class:"payment-channel-meta"},el("p",{class:"muted"},validation),el("p",{class:"muted"},"草稿版本："+(c.draftId||"无")+" · 已启用版本："+(c.activeId||"无")),el("label",{},"回调地址（在服务商后台配置）",el("input",{value:r.webhookUrl,readonly:true})),c.channel==="dujiaopay"?el("p",{class:"muted"},"收款钱包地址在 DujiaoPay 商户后台管理。"):null),el("div",{class:"actions supplier-toolbar"},verify,enable));
    }
    return button("配置与启用",()=>{const focus=document.activeElement;dialog=el("dialog",{class:"workspace-modal payment-config-modal","aria-label":names[c.channel]+"配置"});dialog.append(el("div",{class:"modal-shell"},el("header",{class:"modal-head"},el("h2",{},names[c.channel]),button("关闭",()=>dialog.close())),el("div",{class:"modal-body"},body)));dialog.addEventListener("close",()=>{body.querySelectorAll('input[type=password]').forEach(i=>i.value="");dialog.remove();focus?.isConnected&&focus.focus();},{once:true});document.body.append(dialog);dialog.showModal();});

  });
  const activeCount=s.channels.filter(c=>managed&&!c.paused&&c.activeId&&s.executionMode!=="disabled").length,configuredCount=s.channels.filter(c=>c.draftId||c.activeId).length;
  const nodes=[workspaceHeading("支付设置","管理平台代收通道；代理余额采购独立核算，不受平台收款开关影响。",[link("支付文档",publicUrl("/developers/payment-channels.md"))]),statChips([["执行模式",executionLabel],["已配置",configuredCount],["收款通道",activeCount],["待核记录",0]],{className:"platform-metrics"}),el("div",{class:"payment-stack"},
    section("运行状态",el("div",{class:"supplier-status-grid"},el("span",{class:"environment-chip "+(s.executionMode==="production"?"":"sandbox")},executionLabel),el("span",{},"支付适配器 ",el("strong",{},managed?"后台托管":"非托管"))),el("p",{class:"payment-notice"},helpLines[0]),el("details",{class:"payment-help-notice"},el("summary",{},"更多说明"),el("ul",{},helpLines.slice(1).map(line=>el("li",{},line))))),
    section("收款通道",table(["通道","当前状态","草稿 / 已启用版本","操作"],s.channels.map((c,index)=>[names[c.channel],tag(managed&&!c.paused&&c.activeId&&s.executionMode!=="disabled"?"active":"disabled"),el("div",{},el("span",{class:"muted"},(c.draftId||"无")+" / "+(c.activeId||"无")),el("p",{class:"order-meta"},channelStatus(c))),el("div",{class:"actions"},channelPanels[index],managed&&!c.paused&&c.activeId?button("关闭通道",()=>disable([c]),"danger"):null)])),managed?el("div",{class:"actions supplier-toolbar"},button("关闭全部通道",()=>disable(s.channels),"danger")):null))];
  const reviews=(await api("/payment-reviews")).data;
  const reasons={creation_result_unknown:"建单结果未知",verification_pending:"服务端核验待重试",payment_binding_mismatch:"订单、金额或网络不匹配",payment_requires_review:"到账证据需人工核对",transaction_reused:"交易流水重复",unknown_payment_status:"未知支付状态"};
  nodes[1]=statChips([["执行模式",executionLabel],["已配置",configuredCount],["收款通道",activeCount],["待核记录",reviews.length]],{className:"platform-metrics"});
  nodes.push(section("USDT 待核对",el("p",{class:"muted"},"人工标记和页面跳转都不会自动发码。点击订单进入原单，核对服务商流水、金额、网络和到账状态。"),reviews.length?table(["订单","状态","原因","更新时间","操作"],reviews.map(p=>[el("button",{type:"button",class:"linkish",onclick:()=>openOrderDetailModal({id:p.orderId})},shortId(p.orderId)),tag(p.state),reasons[p.reason]||"待核对",date(p.updatedAt),button("订单详情",()=>openOrderDetailModal({id:p.orderId}),"primary")])):el("p",{class:"empty"},"暂无待核对记录")));
  return nodes;
}
`;
