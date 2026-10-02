import {runInNewContext} from "node:vm";
import {describe, expect, it, vi} from "vitest";
import {workspaceJs} from "../src/operations/workspace-page.js";

// Run the shipped account list/dialog functions. No browser login, production data or real account writes.
class TestNode {
  className = "";
  dataset: Record<string, string> = {};
  children: TestNode[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(event: {preventDefault: () => void}) => unknown>>();
  parent: TestNode | null = null;
  value = "";
  disabled = false;
  open = false;
  constructor(readonly tagName: string, private text = "") {}
  get textContent(): string {return this.text + this.children.map(child => child.textContent).join("");}
  set textContent(value: string) {this.text = value; this.children = [];}
  get innerHTML() {return this.textContent;}
  set innerHTML(value: string) {this.textContent = value;}
  setAttribute(name: string, value: string) {this.attributes.set(name, value); if (name === "value") this.value = value;}
  getAttribute(name: string) {return this.attributes.get(name) ?? null;}
  append(...children: TestNode[]) {for (const child of children) {child.parent = this; this.children.push(child);}}
  addEventListener(name: string, listener: (event: {preventDefault: () => void}) => unknown) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  async dispatch(name: string) {for (const listener of this.listeners.get(name) ?? []) await listener({preventDefault() {}});}
  click() {return this.dispatch("click");}
  showModal() {this.open = true;}
  close() {this.open = false; void this.dispatch("close");}
  remove() {if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null;}
  querySelectorAll(selector: string): TestNode[] {
    const matches = (node: TestNode) => {
      if (selector.startsWith("#")) return node.getAttribute("id") === selector.slice(1);
      const match = selector.match(/^(\w+)?(?:\[([\w-]+)(?:="?([^"\]]*)"?)?\])?$/);
      return Boolean(match && (!match[1] || node.tagName === match[1])
        && (!match[2] || (match[3] === undefined ? node.attributes.has(match[2]) : node.getAttribute(match[2]) === match[3])));
    };
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string) {return this.querySelectorAll(selector)[0] ?? null;}
}
const platformRows = [
  {id: "admin", username: "operator", displayName: "平台管理员", role: "platform_admin", merchantId: null, status: "active"},
  {id: "legacy", username: "legacy-finance", displayName: "历史财务账号", role: "platform_finance", merchantId: null, status: "disabled"},
];

function harness(rows = platformRows) {
  const body = new TestNode("body"), messages: string[] = [], calls = vi.fn(async () => ({data: rows}));
  const document = {body, querySelector: () => null, addEventListener() {}, hidden: false,
    createElement: (tag: string) => new TestNode(tag), createTextNode: (text: string) => new TestNode("#text", text)};
  class TestFormData {
    constructor(private form: TestNode) {}
    *[Symbol.iterator]() {for (const node of this.form.querySelectorAll("[name]")) yield [node.getAttribute("name"), node.value];}
  }
  const context: any = {AbortController, setTimeout, clearTimeout, URL, URLSearchParams, Node: TestNode, FormData: TestFormData,
    document, calls, messages, window: {addEventListener() {}}, localStorage: {getItem: () => null},
    location: {origin: "https://tibo.test", hostname: "tibo.test", protocol: "https:", search: ""}};
  runInNewContext(workspaceJs.split("\napplyEntryQuery();")[0] + `
    api=calls;render=async()=>{};tell=message=>messages.push(message);
    globalThis.hooks={accounts,openCreateAccountModal,canCreateWorkspaceAccount,
      identity:(role,tenant,permissions)=>{me={id:'operator',role};merchant=tenant;perms=permissions;}};`, context);
  context.hooks.identity("platform_admin", "", ["*"]);
  return {h: context.hooks, body, calls, messages};
}
function roleOptions(body: TestNode) {
  return body.querySelector('select[name="role"]')!.querySelectorAll("option").map(node => node.getAttribute("value"));
}
function fillAccount(body: TestNode, role: string) {
  for (const [name, value] of Object.entries({username: "test-member", displayName: "代理测试账号", password: "synthetic-password", role})) {
    body.querySelector(`[name="${name}"]`)!.value = value;
  }
}

describe("single-operator workspace account entry scope", () => {
  it("removes platform personnel creation without hiding or mutating historical accounts", async () => {
    const {h, body, calls} = harness(); body.append(...await h.accounts());
    expect(body.textContent).toContain("当前按单管理员运营");
    expect(body.textContent).toContain("历史财务账号");
    expect(body.textContent).toContain("legacy-finance");
    expect(body.querySelectorAll("button").map(node => node.textContent).sort()).toEqual(["停用", "启用"].sort());
    expect(calls.mock.calls).toEqual([["/accounts"]]);
  });

  it("cannot reopen the unscoped platform creation dialog even with a selected agent", () => {
    const {h, body, calls, messages} = harness(); h.identity("platform_admin", "agent-a", ["*"]);
    h.openCreateAccountModal();
    expect(h.canCreateWorkspaceAccount()).toBe(false);
    expect(body.querySelector("dialog")).toBeNull();
    expect(calls).not.toHaveBeenCalled();
    expect(messages[0]).toContain("代理账号请在代理管理中创建");
  });

  it("keeps scoped agent creation for the administrator and pins the submitted tenant", async () => {
    const {h, body, calls} = harness(); h.openCreateAccountModal("agent-a");
    expect(roleOptions(body)).toEqual(["agent_owner", "agent_staff", "agent_finance"]);
    expect(body.querySelector("dialog")!.open).toBe(true);
    fillAccount(body, "agent_owner");
    h.identity("platform_admin", "agent-b", ["*"]);
    await body.querySelector("form")!.dispatch("submit");
    expect(calls).toHaveBeenCalledExactlyOnceWith("/accounts", "POST", {
      username: "test-member", displayName: "代理测试账号", password: "synthetic-password", role: "agent_owner", merchantId: "agent-a",
    });
    expect(body.querySelector("dialog")).toBeNull();
  });

  it("retains the agent owner's create action and only offers roles in their own tenant", async () => {
    const {h, body, calls, messages} = harness([]); h.identity("agent_owner", "agent-a", ["accounts.read", "accounts.manage"]);
    body.append(...await h.accounts());
    await body.querySelectorAll("button").find(node => node.textContent === "+ 新建账号")!.click();
    expect(messages).toEqual([]);
    expect(roleOptions(body)).toEqual(["agent_staff", "agent_finance"]);
    fillAccount(body, "agent_staff"); await body.querySelector("form")!.dispatch("submit");
    expect(calls).toHaveBeenLastCalledWith("/accounts", "POST", expect.objectContaining({merchantId: "agent-a", role: "agent_staff"}));
    expect(h.canCreateWorkspaceAccount("agent-b")).toBe(false);
    h.openCreateAccountModal("agent-b"); expect(body.querySelector("dialog")).toBeNull();
  });

  it.each(["platform_auditor", "platform_finance", "agent_staff"])("does not give %s a creation action", async role => {
    const {h, body, calls} = harness(); h.identity(role, role.startsWith("agent_") ? "agent-a" : "", ["accounts.read"]);
    body.append(...await h.accounts()); h.openCreateAccountModal("agent-a");
    expect(body.querySelectorAll("button")).toHaveLength(0);
    expect(body.querySelector("dialog")).toBeNull();
    expect(calls.mock.calls).toEqual([["/accounts"]]);
  });
});
