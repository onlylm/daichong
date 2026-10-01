# 代理商完整联调示例

本示例同时包含代理商商城前端、代理商服务端签名代理和 Webhook 接收器。`client_secret` 只存在 Node.js 服务端，浏览器无法读取。

启动 Quefa 沙箱后，在另一个终端运行：

```powershell
$env:QUEFA_BASE_URL='http://127.0.0.1:3200'
$env:QUEFA_PARTNER_ID='pt_demo_a'
$env:QUEFA_KEY_ID='key_demo_a_01'
$env:QUEFA_CLIENT_SECRET='replace-with-demo-secret-at-least-32-chars'
$env:QUEFA_WEBHOOK_SECRET='replace-demo-webhook-secret'
$env:QUEFA_REGISTERED_WEBHOOK_URL='http://host.docker.internal:3300/webhooks/quefa'
node examples/partner-demo/server.mjs
```

浏览器打开 `http://127.0.0.1:3300`，依次创建订单、打开沙箱付款页、确认付款、查询支付、提交履约并查看 Webhook。

若 Quefa API 不在 Docker 中运行，把 `.env` 和上述 `QUEFA_REGISTERED_WEBHOOK_URL` 同时改成 `http://127.0.0.1:3300/webhooks/quefa`，两端必须完全一致。
