# Quefa 下游统一对接标准

版本 1.3 · 2026-10-02（本地候选，生产能力以已部署版本及代理授权为准）
接口前缀：`/v1`  
生产 Base：`https://tibo.ink/v1`  
机器可读：`https://tibo.ink/developers/openapi.yaml`  
联调示例：`examples/partner-demo/`、`examples/signing/`

> 本文档是 **Quefa 对下游（代理商 / 自建商城 / 其他平台）的正式对接标准**。  
> 代理商默认可创建服务端 API 密钥，无需申请或预存；零采购余额只能使用平台收款。完成密钥、回调登记和联调后再上线。
> 自建模式下 Quefa 提供后端能力；客户前端、品牌站、订单页由下游自行开发与托管。不开发网站也可直接使用代理工作台，两种入口可并存。

与历史关系：早期有下游平台曾用「上游提供 `/api/v1/checkout/*`」协议接入我们。  
现在角色对调——**Quefa 定义标准，下游按本文档对接我们**。字段与路径以本文档和 OpenAPI 为准，不再要求下游实现 checkout 供货接口。

---

## 目录

1. 总览  
2. 接入流程  
3. 通用约定  
4. 接口  
   - 4.1 商品目录  
   - 4.2 开单  
   - 4.2.1 自有页面取付款码
   - 4.3 查单  
   - 4.4 交付（CDK / 自动直充）  
   - 4.5 查履约 / 兑换进度  
   - 4.6 失败原因码  
5. 回调  
6. 开通途中的安全验证  
7. 退款与补差  
8. 必须遵守的规则  
附录 A：错误码总表  
附录 B：变更记录  
附录 C：与旧「上游 checkout 协议」的对照  

---

## 1. 总览

### 1.1 分工

| | Quefa（我方） | 下游（你方） |
|---|---|---|
| 面对买家 | 不直接运营你的品牌站 | 展示商品、接单、收款展示、收 Session、展示结果 |
| 收款 | `platform_collect`：平台出码/收款并确认到账；`agent_collect`：只扣你的采购余额 | 自有品牌站经代理后端取码后在自己页面展示；旧接入保留付款链接；自收款时你自己收买家款 |
| 开通 / 交付 | 履约、签发代理品牌公开号、自动直充、统一失败码 | 把买家凭据经你的后端转交；或直接交付完整品牌码 |
| 调用方向 | 你主动调我方 `/v1`（第 4 节） | 我方向你推送 Webhook（第 5 节），只作提醒 |

### 1.2 你要实现的东西

| # | 能力 | 说明 |
|---|---|---|
| 1 | 服务端签名客户端 | 所有写操作走你的后端；浏览器不得持有 `client_secret` |
| 2 | 拉商品目录 | `GET /v1/products` |
| 3 | 开单 | `POST /v1/orders`（`merchant_order_no` + `Idempotency-Key`） |
| 4 | 查单 | `GET /v1/orders/{order_id}`（付款是否到账的唯一事实来源） |
| 5 | 交付 | CDK 交付公开号，或 `POST /v1/redemptions` 自动直充 |
| 6 | 查进度 | `GET /v1/redemptions/{id}` 或订单履约列表 |
| 7 | 收回调 | 验签 + 按 `event_id` 去重，然后立刻查单 |
| 8 | 退款申请（可选） | `POST /v1/orders/{order_id}/refunds`（平台代收场景） |
| 9 | 原站付款码（按代理开通） | `POST /v1/orders/{order_id}/payment-code`，后端取码、自己的前端展示 |

路径前缀 `/v1` 固定，接在 Base 后面。例：Base = `https://tibo.ink/v1`，开单即 `POST https://tibo.ink/v1/orders`。

### 1.3 一张单的完整流程（推荐：平台代收 + 自动直充）

```text
下游                                              Quefa
 │  1. POST /orders {merchant_order_no, product, sale_amount,
 │                   collection_mode=platform_collect,
 │                   delivery_mode=auto_recharge}
 │ ─────────────────────────────────────────────────────────▶ │  创建订单 / 支付入口
 │ ◀──────── {order_id, payment_status=pending, pay 相关字段}
 │
 │  POST /orders/{order_id}/payment-code {} → payment_code / qr_image_data_url
 │  （代理后端转交付款码；买家在你站扫码付款，钱进平台通道）
 │
 │ ◀────────────── 回调 order.paid（只是提醒）                 │  确认到账
 │  2. GET /orders/{order_id} → payment_status=paid           │  ← 你方以这里为准
 │
 │  （买家在你的订单页粘贴 ChatGPT Session）
 │
 │  3. POST /redemptions {mode=auto_recharge, order_id, credential…}
 │ ─────────────────────────────────────────────────────────▶ │  受理开通
 │ ◀──────── {redemption_id, status=queued|running…}
 │
 │  4. GET /redemptions/{id}（建议每 3 秒）
 │ ◀──── running … [可能要求安全验证，见第 6 节] … succeeded
 │
 │  交付给买家，完成
```

`agent_collect` 差异：开单时从采购余额扣供货价，`paid` **只表示采购已扣**，不表示买家已向你付款；买家零售退款由你方自行处理。

### 1.4 两条贯穿全文的原则

1. **查询接口是唯一的事实来源。**  
   付没付款只看查单；开没开通只看履约/兑换查询。回调只是「去查一下」的提醒。回调全部丢失也不会丢单，只是变慢。

2. **同一个请求可能到达多次。**  
   网络超时后你会重试，所以开单必须带稳定的 `merchant_order_no` 与相同的 `Idempotency-Key`；回调也可能重推，你方必须按 `event_id` 去重。

---

## 2. 接入流程

### 2.1 你方提供

| 项目 | 说明 |
|---|---|
| Webhook URL | HTTPS，在工作台预登记；开单 `notify_url` 必须与登记地址完全一致 |
| 出口 IP（可选） | 在代理工作台按应用自行保存服务器固定出口 IP；确认无误后再启用强制白名单 |
| 收款模式意向 | 仅平台代收 / 仅自收款扣余额 / 两者都要 |
| 交付方式 | `cdk`、`auto_recharge` 或两者 |
| 退款对接人 | 平台代收退款审核与异常联系人 |
| 技术联系人 | 联调与线上故障 |

### 2.2 我方提供

| 项目 | 说明 |
|---|---|
| API Base | 生产 `https://tibo.ink/v1`；沙箱另发 |
| `partner_id` / `key_id` / `client_secret` | API 默认开放，代理主账号在工作台创建；`client_secret` 只显示一次；平台风控停用时拒绝调用 |
| `webhook_secret` | 与 `client_secret` **必须不同**，用于验回调 |
| 商品授权与价格 | 供货价、可售编码及交付方式；`max_sale_price` 为历史兼容字段 |
| 开发者中心 | `https://tibo.ink/developers` |

### 2.3 联调步骤（按序，一步过再下一步）

1. **连通性**：错误签名 / 过期时间戳 / 重放 Nonce 均被拒绝；正确签名可拉商品。  
2. **商品目录**：双方核对 `product_code`、供货价、`delivery_modes`。
3. **开单 + 查单**：同幂等键重放返回同一单；异内容同键返回冲突。  
4. **回调**：收到 `webhook.test` 或真实 `order.paid`，验签通过并返回 2xx。  
5. **纯支付联调**：用 `POST /v1/payment-tests` 创建固定 1 元订单，确认付款、查单和回调；该用途不进入 CDK 或上游充值，不可用正式商品改价替代。
6. **正式商品履约**：经业务方确认后，四款正式商品按正常售价验证自动直充或 CDK 交付到终态；这是会真实扣款和履约的独立步骤。
7. **异常路径**：在隔离环境验证明确失败后的原单重提与未付款过期，不用生产真实充值制造异常。

---

## 3. 通用约定

### 3.1 请求

- 全部 HTTPS；UTF-8 JSON；`Content-Type: application/json`。  
- 每个请求带 Partner 签名头（见 3.2）；**不得**把密钥放进浏览器。  
- 拓扑：`买家浏览器 → 你的前端 → 你的后端 → Quefa /v1`。

### 3.2 签名（必须实现）

```http
X-Partner-Id: pt_xxx
X-Key-Id: key_xxx
X-Timestamp: <Unix 秒>
X-Nonce: <一次性>
X-Signature: <64 位小写 hex>
Idempotency-Key: <POST 必填；GET 视为空串>
```

规范串：

```text
METHOD\nPATH\nCANONICAL_QUERY\nTIMESTAMP\nNONCE\nKEY_ID\nIDEMPOTENCY_KEY\nSHA256_HEX(RAW_BODY)
```

`signature = lowercase_hex(HMAC-SHA256(client_secret, canonical_string_utf8))`  
时间窗 ±300 秒；Nonce 10 分钟内不得复用。先序列化再签名，签完的字节与 HTTP 发送字节必须一致。

### 3.3 响应与重试

成功时业务数据在 `data` 中，分页方式按接口区分：订单、账单和结算单列表使用响应顶层 `next_cursor`，没有下一页时为 `null`；工单列表使用 `meta`；钱包流水使用 `entries` 和 `entries_meta`。不要给所有列表套用同一种分页结构。失败：

```json
{
  "error": {
    "code": "order_not_found",
    "message": "订单不存在",
    "request_id": "req_...",
    "retryable": false
  }
}
```

| 响应 | 你方处理 |
|---|---|
| 2xx | 成功（履约受理常见 202，表示已受理不是已开通） |
| 4xx（429 除外）且 `retryable: false` | 永久错误，修正后用新业务键 |
| 429 / 5xx / 超时 / `retryable: true` | 退避重试；写操作保持原 `Idempotency-Key` |
| 409 `idempotency_in_progress` | 原请求仍在执行；先查询原订单/任务，再以原业务键和新 Nonce 退避重试 |
| 支付/履约结果未知 | **只查单**，不要盲目再开一单或再开一次兑换 |

### 3.4 金额与时间

- 金额：两位小数字符串，单位元，币种 `CNY`，如 `"139.00"`。不要用数字类型、不要用分。  
- 时间：RFC 3339 UTC。签名时间戳为 Unix 秒。

### 3.5 标识

| 标识 | 谁生成 | 说明 |
|---|---|---|
| `merchant_order_no` | 你方 | 你的业务订单号，≤64；开单幂等业务键之一 |
| `order_id` | Quefa | 平台订单号；之后查单、兑换、退款都用它 |
| `Idempotency-Key` | 你方 | HTTP 幂等键；同键同摘要返回首次结果 |
| `redemption_id` / `fulfillment_id` | Quefa | 一次开通/兑换尝试 |
| `event_id` | Quefa | Webhook 业务去重键 |

### 3.6 兼容性

- 我方可能新增字段，你方应忽略不认识的字段。  
- 已有字段、错误码、状态值不改名、不删、不改含义；破坏性变更提前公告并升版。

---

## 4. 接口

### 4.1 商品目录

`GET /v1/products`

返回当前代理已授权且可售的商品。上架前先拉目录，价格与库存以实时响应为准，禁止写死。

正式商品只保留 Plus（`chatgpt_plus_cdk_1m`）、Pro 5x（`chatgpt_pro_5x_cdk_1m`）、Pro 20x（`chatgpt_pro_20x_cdk_1m`）、Pro 50x（`chatgpt_pro_50x_cdk_1m`）。历史商品不再接受新订单。`POST /v1/payment-tests` 是独立固定 1 元测试用途，不在商品目录中；不签发 CDK、不创建充值任务、不计算佣金、不调用上游。

关键字段：`product_code`、`name`、`supply_price`、`max_sale_price`、`currency`、`max_quantity`、`available`、`fulfillment_mode`、`delivery_modes`。

`sale_amount` 是整单总额，必须不低于 `supply_price × quantity`。`max_sale_price` 保留为历史兼容字段，当前后端不使用它限制售价上限；不得将其为 `0.00` 等历史值理解为免费或不可售。`available=false` 时不要开单。

### 4.2 开单

`POST /v1/orders`  
头：`Idempotency-Key` 必填。

```json
{
  "merchant_order_no": "M202609290001",
  "product_code": "chatgpt_plus_cdk_1m",
  "quantity": 1,
  "sale_amount": "139.00",
  "collection_mode": "platform_collect",
  "delivery_mode": "auto_recharge",
  "notify_url": "https://your.example.com/quefa/webhook",
  "metadata": {"cart_no": "C10086"}
}
```

| 字段 | 说明 |
|---|---|
| `merchant_order_no` | 你的单号；重试必须相同 |
| `sale_amount` | 买家侧售价（平台代收时为买家实付口径） |
| `collection_mode` | `platform_collect` / `agent_collect` |
| `delivery_mode` | `cdk` / `auto_recharge` |
| `payment_channel` | 平台收款仅支持 `alipay`（可省略），不支持 USDT；余额采购不传 |
| `notify_url` | 必须已预登记；生产必须 HTTPS |
| `metadata` | 仅非敏感业务标识；**禁止**放 Session/密码 |

**幂等**：同一租户、路由、`Idempotency-Key` 且请求摘要相同 → 返回首次建单结果（含同一 `order_id`）。同键不同内容 → `409 idempotency_conflict`。

#### 4.2.1 自有页面取付款码

`POST /v1/orders/{order_id}/payment-code`，必须由代理后端携带 HMAC 签名和 `Idempotency-Key` 调用，请求体固定为 `{}`。

该能力由平台按代理开通；未开通返回 `403 direct_payment_code_disabled`。平台校验订单归属、待付款状态、有效期及支付宝平台收款配置，金额、币种、有效期和支付配置只取服务端订单，禁止请求覆盖。

```json
{
  "data": {
    "order_id": "ord_xxx",
    "merchant_order_no": "M202609290001",
    "amount": "139.00",
    "currency": "CNY",
    "payment_status": "pending",
    "payment_code_type": "alipay_precreate",
    "payment_code": "https://qr.alipay.com/example",
    "qr_image_data_url": "data:image/png;base64,...",
    "expires_at": "2026-10-02T09:30:00.000Z"
  }
}
```

代理后端转交图片数据给自己的前端，或用 `payment_code` 本地绘码；买家浏览器不得直连平台 API 或第三方绘码服务，不得接触平台密钥、供货价和内部字段。旧 `qr_payload` 仍表示平台付款页 URL，不是实际支付宝付款码，含义保持兼容。

重复取码复用原支付记录。同幂等键重放和首次生成返回前均复验当前订单及开关；已付款、到期、关闭或停用后不返回旧待付款码。到账仍以验签通知或签名查单为准，过期不能替代晚到款核对。

### 4.3 查单

`GET /v1/orders/{order_id}`

列表使用 `GET /v1/orders?payment_status=&cursor=&limit=`，默认 20 条、最大 100 条。响应示例为 `{"data": [], "next_cursor": null}`；下一页传上次返回的顶层 `next_cursor`，并原样保留筛选条件。不要从 `meta` 读取订单游标。

**判断「付没付款 / 采购扣没扣」的唯一依据。**

支付状态（摘要）：

```text
pending ──确认──▶ paid ──退款──▶ partially_refunded / refunded
   │
   └──过期/关闭──▶ expired / closed
```

| status | 含义 | 你方处理 |
|---|---|---|
| `pending` | 等待付款（或待确认） | 继续查 |
| `paid` | 平台代收：买家已付；自收款：采购余额已扣 | 进入交付 |
| `expired` / `closed` | 未完成付款流程 | 关闭付款入口；仍处理晚到的验签付款通知并查询原单，不能忽略后来确认的到账 |
| `partially_refunded` / `refunded` | 已发生退款 | 按退款接口与账单核对；若同时 `sync_mark=cancelled_refunded`，可关闭本地「充值取消已退」订单 |

查单还会返回最近一次履约摘要（只读派生字段，不替代履约明细接口）：

| 字段 | 含义 |
|---|---|
| `fulfillment_status` | 最近履约：`queued/running/succeeded/failed/cancelled`，无则为 `null` |
| `fulfillment_failure_code` | 最新失败码；历史 `agent_cancelled` 仅兼容，当前不允许代理主动取消 |
| `retry_allowed` | 仅最新尝试明确失败且安全结束时允许原单重提 |
| `sync_mark` | 充值已取消且已退款时为 `cancelled_refunded`，否则 `null` |

建议轮询：开单后前 2 分钟每 3 秒，之后降低频率，直到过期后一小段时间；收到 `order.paid` 时立即查一次。

### 4.4 交付（CDK / 自动直充）

当前 GPT 成品由 CDK 库存支撑。开单时选定 `delivery_mode`：

#### A. 直接交付 CDK（`delivery_mode=cdk`）

付款/扣款确认后轮询订单或收 `cdk.issued`，将完整 `voucher_code`（代理品牌公开号）交给买家；不得按固定前缀、分组或分隔符解析。
上游原始卡密永不返回给你的 API、页面、Webhook 或日志。

#### B. 自动直充（`delivery_mode=auto_recharge`，推荐自有品牌站）

不返回明文 CDK。买家在你的订单页提交凭据后，你的后端调用：

`POST /v1/redemptions`

```json
{
  "mode": "auto_recharge",
  "order_id": "ord_...",
  "credential": {
    "mode": "session",
    "session": "<客户本次授权的完整 Session JSON 字符串>"
  },
  "customer_confirmed_email": true
}
```

- 须开通自建兑换权限（`customRedemptionEnabled`）。  
- **Session / Token 不得写入你的日志、不得进 `metadata`、开通结束后不得留存。**  
- 202 = 已受理，不是成功。  
- 最新尝试明确失败、`retry_allowed=true`、`next_action=resubmit` 且自动直充 `fallback_recharge_available=true` 时，在你的订单页重新显示输入入口。原单须仍可履约且无退款锁定。重交使用新的 `Idempotency-Key`；网络重传仍用原键。不返回 CDK，不要求跳转平台品牌页。

历史 `POST /v1/orders/{order_id}/fulfillments` 仅为旧 direct 订单兼容保留，新代理商和当前四项套餐不得使用。

### 4.5 查履约 / 兑换进度

- `GET /v1/redemptions/{id}`  
- 或查订单 / 接收验签 Webhook 获取最新履约状态

**判断「开没开通」的唯一依据。**

稳定状态：`queued` / `running` / `succeeded` / `failed` / `cancelled`。  
`result_code` / `result_stage` 中的中间态（如 `requires_action`、`review`、`funding_pending` 等）**不是失败**，必须继续查。

同一订单同一时间应只有一条进行中的开通；重复提交按错误码处理，不要让买家无脑连点。

你的后端必须把 `status/message/failure_code/retry_allowed/next_action` 同步给代理工作台及客户订单页。细分阶段 `result_code/result_stage` 当前按代理可见性开放，未返回时只显示“排队中/处理中”。不编造百分比，不能把网络超时或中间态显示成最终失败。

本版本新增 `fulfillment.updated` 阶段变化通知，部署同版后生效；回调订阅该事件或 `*`。查询和通知统一包含 `attempt_no/progress_stage/progress_version/progress_updated_at/recovery_action`。统一阶段默认公开，敏感字段仍按授权返回。新尝试优先，同任务较低版本不覆盖新版本；重复轮询不生成重复通知。

每个任务只保留一个在途查询，前 2 分钟每 3–5 秒，之后退避至 15–30 秒。Webhook 加速，查询兜底；验签和去重后核对当前尝试。明确失败且 retry_allowed=true 后允许在原订单修正资料，以新幂等键提交；管理员取消未派发任务后也可开放原单重提，不再次收款。管理员选择退款则关闭入口。已派发、未知或已成功的任务不能本地强制取消。

### 4.6 失败原因码

失败记录带机器可读失败码。你方按码决定下一步；给买家看的文案由你方编写，不要原样转发内部说明。

| failure_code | 含义 | 建议处理 |
|---|---|---|
| `session_invalid` | Session 过期/不完整/已登出 | 请买家重新复制再交 |
| `account_has_subscription` | 已有付费订阅 | 换免费账号 |
| `region_unsupported` | 地区不支持 | 换号或走售后 |
| `payment_blocked` | 上游付款被风控/验证拦住 | 转人工，勿同一 Session 死磕 |
| `verification_timeout` | 原任务结果或验证未确认 | 查询原任务并联系支持；仅超时不能自行重交 |
| `service_unavailable` | 临时故障 | 保持查询原任务，不能自动另建充值 |
| `other` | 其他 | 带 `request_id` 联系客服 |

不认识的码按 `other` 处理。需要新增码时由 Quefa 公告后再启用。

失败页至少显示安全原因、本站订单号和下一步入口。代理后台另外保存平台订单号、任务号和 `X-Request-Id` 供排障；不给客户返回上游卡密、凭据或原始排障信息。明确失败并允许恢复时，展示代理自己生成且有客户鉴权的充值页面或订单链接。

---

## 5. 回调

### 5.1 事件（摘要）

| 事件 | 何时 | 必须处理 |
|---|---|---|
| `order.paid` | 付款/采购扣款确认 | 是 |
| `order.expired` | 未付款过期 | 建议 |
| `order.closed` | 支付渠道明确关闭未付款交易 | 关闭付款入口；仍以最新查单处理晚到款 |
| `cdk.issued` | 公开号就绪 | `delivery_mode=cdk` 时 |
| `cdk.failed` | 签发明确失败，含 `order_id`、`failure_code` | 查原单及平台处理，不重复付款；不代表退款到账 |
| `cdk.disabled` | 平台侧兑换码已停用，含 `order_id` | 停止使用旧码；不证明上游原始码已作废 |
| `fulfillment.updated` | 受理、业务阶段或恢复操作变化 | 建议订阅；相同状态不重复通知 |
| `fulfillment.succeeded` / `failed` / `cancelled` | 开通终态 | 是 |
| `refund.succeeded` | 退款成功；可含 `payment_status`、`fulfillment_status`、`sync_mark` | 申请过退款时；`sync_mark=cancelled_refunded` 时可同步关闭本地单 |
| `procurement.refunded` | 采购余额退回 | 不代表客户零售款已退 |
| `wallet.deposit.credited` | 支付宝采购余额充值入账，含 `deposit_id`、`amount` | 查钱包核对，不视为客户订单付款或代理打款 |
| `webhook.test` | 联调 | 联调时 |

退款驳回与每日核算生成、登记打款目前没有独立 Webhook，通过退款、结算查询或工作台查看。平台不发送邮件，也不自动向代理打款；自动生成核算单、自动记账不是自动出款。

收到后只做一件事：**验签 → 去重 → 立刻查对应查询接口**。不要只凭回调改本地终态。

### 5.2 签名

```http
X-Quefa-Event: order.paid
X-Quefa-Event-Id: evt_...
X-Quefa-Delivery: dlv_...
X-Quefa-Timestamp: <Unix 秒>
X-Quefa-Signature: t=<秒>,v1=<hex>
```

`v1 = hex(HMAC-SHA256(webhook_secret, "<t>." + 原始请求体字节))`  
拒绝超过 300 秒时钟差的请求。按 `event_id` 去重；`delivery_id` 仅标识投递尝试。

成功响应：HTTP 2xx（建议 5 秒内）。失败我将退避重推（约 1、5、15、60、360 分钟量级）。

---

## 6. 开通途中的安全验证

部分开通需要买家完成人机验证或银行 3DS。此时进度保持非终态（如 `running` / `requires_action`），并可能带验证所需信息。

你方订单页应：

1. 轮询读到验证要求后，在**你的域名页面**内引导买家完成（嵌入策略以我方当时返回字段为准）；  
2. 验证完成后继续轮询至 `succeeded` / `failed`；  
3. 验证超时按 `verification_timeout` 查询原任务，只有最新尝试明确允许重提时再开放入口；目前没有统一的验证链接字段，不能自行拼接上游验证地址。

不得把验证页做成诱导离开你站、或要求买家登录 Quefa 账号的流程。

---

## 7. 退款与补差

适用于 **`platform_collect`（平台代收）**：

1. 你方 `POST /v1/orders/{order_id}/refunds` 申请（`full` / `partial` / `price_adjustment`）。  
2. 接口只受理；出款以平台审核与支付通道确认为准。  
3. 以查退款 / 查单 / `refund.succeeded` 回调为准，不要假设同步到账；驳回结果需查询，不能等待不存在的驳回通知。
4. 存在进行中或已成功履约时，可能进入人工复核。

**`agent_collect`**：平台订单上的退款接口不替你退买家零售款；采购侧余额退回按工作台/合同规则处理，买家侧退款由你方支付通道自行完成。

只做文档约定范围内的退款类型；补差（`price_adjustment`）不否定已成功履约，**也不冲减代理商佣金**（上游成本下降时由平台承担差价退给买家）。普通退款才会减少代理差价与待结算。

---

## 8. 必须遵守的规则

对接前请逐条确认：

1. 浏览器不持有 `client_secret` / `webhook_secret`；签名只在服务端完成。  
2. 开单使用稳定的 `merchant_order_no` + 相同 `Idempotency-Key` 做重试。  
3. 付没付款、开没开通，只认查询接口；回调只触发再查。  
4. `agent_collect` 的 `paid` 不得展示成「买家已付款」。  
5. `auto_recharge` 失败不展示明文 CDK，不把买家赶到 Quefa 品牌页。  
6. Session / Token 不进日志、不进 `metadata`、不进 Webhook、不落长期库。  
7. 失败码驱动分支；中间态 `result_code` 不当作失败。  
8. Webhook 验签 + `event_id` 去重；时钟 NTP 同步。  
9. 整单售价不低于供货价乘以数量；未授权商品不开单。
10. 已有字段与错误码不擅自改名理解；有疑问以 OpenAPI 与本文档为准。

---

## 附录 A：错误码总表（常用）

| code | HTTP | 说明 |
|---|---|---|
| `invalid_signature` | 401 | 签名不对 |
| `timestamp_out_of_range` | 401 | 时钟偏差 |
| `nonce_replayed` | 409 | Nonce 重放 |
| `api_access_required` | 403 | 未开通 API |
| `ip_not_allowed` | 403 | IP 白名单 |
| `product_not_authorized` | 403 | 商品未授权 |
| `order_not_found` | 404 | 单号不存在或不属于你 |
| `idempotency_conflict` | 409 | 同键不同内容 |
| `invalid_state_transition` | 409 | 状态不允许 |
| `price_out_of_range` | 422 | 售价越界 |
| `order_not_paid` | 409 | 未支付不可履约 |
| `rate_limited` | 429 | 限流 |
| `temporarily_unavailable` | 503 | 临时不可用 |

完整表见 OpenAPI 与 `docs/partner-integration.md`。

---

## 附录 B：变更记录

| 版本 | 日期 | 说明 |
|---|---|---|
| 1.0 | 2026-09-29 | 首版：明确 Quefa 为标准制定方，下游按 `/v1` Partner API 统一对接部署 |
| 1.1 | 2026-09-30 | 明确进度与失败原因同步、终态通知加查询、恢复入口与未知结果限制；修正 Session 请求字段 |
| 1.2 | 2026-09-30 | 实现阶段变化通知与进度版本；管理员确认取消后选择退款或开放原订单重提。生产须部署同版后生效 |
| 1.3 | 2026-10-02 | 校准四款正式商品、1 元纯支付用途、默认 API 与原站取码；修正订单游标和实际事件清单，不新增运行功能 |

---

## 附录 C：与旧「上游 checkout 协议」的对照

| 旧协议（他方平台文档，我方曾当上游实现） | 本标准（下游对接 Quefa） |
|---|---|
| 下游调上游 `POST /api/v1/checkout/orders` | 下游调 Quefa `POST /v1/orders` |
| 上游出收款码，钱进上游 | 默认平台代收；亦可代理自收款 + 扣采购余额 |
| `client_order_id` | `merchant_order_no` + `Idempotency-Key` |
| `X-API-Key` | HMAC 签名头（`X-Partner-Id` 等） |
| `POST …/activate` + Session | `POST /v1/redemptions`（自动直充）或履约接口 |
| `GET …/activation` | `GET /v1/redemptions/{id}` / fulfillments |
| 站内待办处理退款 | 平台代收：退款申请 + 平台通道原路退款 |
| 登记上游 base_url 即可被平台调用 | 下游登记 Webhook，并持有 Quefa 发放的密钥来调用我们 |

若你方系统曾按旧 checkout 协议对接「我们当上游」的环境，迁移到本标准时：不要再实现 checkout 供货接口；改为作为 **Partner 客户端** 调用本文第 4–5 节。

---

## 相关文档

- 完整字段与错误细节：`docs/partner-integration.md`（开发者中心「接入文档」）  
- 自有品牌商城页面链路：`docs/23-代理商自有品牌商城与自动直充接入指南.md`  
- 支付通道：`docs/payment-channels.md`  
- OpenAPI：`openapi/openapi.yaml`
