import {runInNewContext} from "node:vm";
import {describe,expect,it,vi} from "vitest";
import {workspaceJs} from "../src/operations/workspace-page.js";

function harness(){
  const calls=vi.fn(async()=>({data:{status:"succeeded"}})),confirm=vi.fn(async()=>true);
  const context:any={AbortController,setTimeout,clearTimeout,URL,URLSearchParams,BigInt,
    location:{origin:"https://tibo.test",hostname:"tibo.test",protocol:"https:",search:""},
    document:{querySelector:()=>null,addEventListener:()=>{},hidden:false},window:{addEventListener:()=>{}},
    localStorage:{getItem:()=>null},calls,confirm,crypto:{randomUUID:()=>"synthetic-fixed-request"}};
  runInNewContext(workspaceJs.split("\napplyEntryQuery();")[0]+`
    api=calls;confirmAction=confirm;tell=()=>{};
    el=(tag,attrs,...children)=>({tag,attrs,children});input=(name,label,type,value,attrs)=>({name,label,type,value,attrs});
    openFormModal=(title,fields,submit,run)=>{globalThis.form={title,fields,submit,run};globalThis.closeButton={disabled:false};return {querySelector:()=>globalThis.closeButton,addEventListener:(event,fn)=>{globalThis[event]=fn;}};};
    globalThis.open=recordExternalCustomerRefund;`,context);
  return {...context,calls,confirm,context};
}
const valid={amount:"10",providerRefundNo:"SYNTH-PARTIAL-10-A",reason:"合成普通部分退款凭证",confirmed:"yes"};
describe("external refund amount form",()=>{
  it("starts with a blank required amount and posts the exact confirmed partial amount, never the ceiling",async()=>{
    const h=harness(),pending=h.open("order-1","135.00");const f=h.context.form;
    expect(f.fields.find((x:any)=>x.name==="amount")).toMatchObject({value:"",attrs:{required:true,max:"135.00",step:"0.01"}});
    await f.run(valid);expect(h.confirm).toHaveBeenCalledWith(expect.stringContaining("¥10.00"));
    expect(h.calls).toHaveBeenCalledWith("/orders/order-1/external-customer-refunds","POST",expect.objectContaining({amount:"10.00",providerRefundNo:valid.providerRefundNo,confirmAlreadyRefundedAtChannel:true}));
    h.context.close();expect(await pending).toBe(true);
  });
  it.each(["","0","-1","135.01","1.001","1e2","NaN"])("rejects invalid or excessive amount %s before confirmation or API",async amount=>{
    const h=harness();h.open("order-1","135.00");await expect(h.context.form.run({...valid,amount})).rejects.toThrow();
    expect(h.confirm).not.toHaveBeenCalled();expect(h.calls).not.toHaveBeenCalled();
  });
  it("keeps input and the request key on failure, and cancellation never posts",async()=>{
    const h=harness(),pending=h.open("order-1","135.00");h.confirm.mockResolvedValueOnce(false);
    expect(await h.context.form.run(valid)).toBe(false);expect(h.calls).not.toHaveBeenCalled();
    h.calls.mockRejectedValueOnce(new Error("offline"));await expect(h.context.form.run(valid)).rejects.toThrow("offline");
    await h.context.form.run(valid);expect(h.calls.mock.calls[0]).toEqual(h.calls.mock.calls[1]);
    h.context.close();expect(await pending).toBe(true);
  });
  it("requires actual evidence and explicit confirmation",async()=>{
    const h=harness();h.open("order-1","135.00");
    for(const extra of [{providerRefundNo:"x"},{reason:" "},{confirmed:""}])await expect(h.context.form.run({...valid,...extra})).rejects.toThrow();
    expect(h.calls).not.toHaveBeenCalled();
  });
  it("blocks dismissal in flight and still reports success if the dialog is externally closed before the response",async()=>{
    const h=harness(),pending=h.open("order-1","135.00");let finish!:(v:any)=>void;
    h.calls.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const submission=h.context.form.run(valid);await vi.waitFor(()=>expect(h.calls).toHaveBeenCalledOnce());
    expect(h.context.closeButton.disabled).toBe(true);const preventDefault=vi.fn();h.context.cancel({preventDefault});expect(preventDefault).toHaveBeenCalledOnce();
    let settled=false;void pending.then(()=>{settled=true;});h.context.close();await Promise.resolve();expect(settled).toBe(false);
    finish({data:{status:"succeeded"}});await submission;expect(await pending).toBe(true);expect(h.context.closeButton.disabled).toBe(false);
  });
});
