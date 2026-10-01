# 开放 API 契约一致性门禁

更新时间：2026-10-01  
适用分支：`refactor/platform-rebuild`

## 目标

代理商应能仅依据 `/developers/openapi.yaml` 生成客户端并完成接入。代码新增、删除或改名 `/v1` 路由时，机器可读文档必须同步；文档不能声明服务端实际不存在的字段。

## 本阶段修正

- 自动读取 Fastify 实际注册的全部 `/v1` 路由，并与 OpenAPI 的路径及 HTTP 方法逐项比较。
- 所有 Partner API 成功响应必须提供 `application/json` schema；所有本地 `$ref` 必须能解析。
- 为代理资料、等级规则、等级申请、普通工单、公告、双钱包及钱包流水补齐响应 schema 和 `operationId`。
- 删除 `/v1/agent-profile` 说明中并不存在的 `suggestedTier`。等级是否可申请以 `rules`、累计指标和服务端申请结果为准，不自动推荐或变更等级。
- 使用真实签名请求校验代理资料、工单列表与详情、公告已读、钱包汇总和流水的实际字段，防止实现与文档再次漂移。

## IP 白名单的当前发布策略

IP 白名单已经按应用实现，但当前保持兼容开放：

- 新旧应用只有在 `ipAllowlistEnabled === true` 时才强制校验；
- 仅保存规则、缺少开关或明确关闭开关，都不会拒绝非白名单来源；
- 代理确认固定出口 IP 后，可在后台对某个应用单独启用；
- 启用后，非白名单调用返回 `403 ip_not_allowed`；
- 工作台登录及平台发出的 Webhook 不受该应用入站白名单影响。

这保证功能先上线可配置，不会立即中断现有代理商 API。

## 自动验证

核心门禁位于 `tests/openapi.test.ts`：

1. OpenAPI 3.1 YAML 可解析；
2. 实际 `/v1` 路径和方法与文档完全一致；
3. 每个成功响应都有 JSON schema；
4. 所有本地 schema 引用可解析；
5. 关键运营接口的真实响应不含未声明字段，也不缺少必填字段；
6. Partner API 不暴露代理支付宝凭据、供应商卡片接口或管理员取消接口。

发布前至少执行：

```bash
npm test -- --run tests/openapi.test.ts
npm run typecheck
npm run check
```

## 后续规则

- 新增 `/v1` 接口时，同一提交内必须补 OpenAPI 路径、成功响应 schema 和签名请求测试。
- 修改响应字段属于公开契约变更；删除或改名字段必须先设计兼容期并提升 API 版本。
- `camelCase` 运营接口与既有订单接口的 `snake_case` 不能由接入方自行猜测，以机器可读 schema 为准。
- `/public` 是平台托管客户页的内部调用面，不属于代理后端 Partner API，不纳入 `/v1` 路由一致性门禁。
