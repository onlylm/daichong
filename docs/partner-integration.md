# 代理商技术接入开发文档

### 当前商品范围（2026-10-01）

仅支持四款套餐代充：Plus、Pro 5x、Pro 20x、Pro 50x；不再受理 Go、单独续费 SKU 或 Codex 点数的新采购。既有订单及流水保留。

| 套餐 | product_code | 当前代理供货价（CNY） |
|---|---|---:|
| Plus | `chatgpt_plus_cdk_1m` | 110 |
| Pro 5x | `chatgpt_pro_5x_cdk_1m` | 638 |
| Pro 20x | `chatgpt_pro_20x_cdk_1m` | 1000 |
| Pro 50x | `chatgpt_pro_50x_cdk_1m` | 3200 |

实际可售状态、最新价格和版本以 `GET /v1/products` 为准。套餐仍由订单绑定 CDK 支撑，交付方式继续可选 CDK 或自动直充，不需要固定指定银行卡。

平台不发送邮件。异常通过站内工单跟踪，API 对接使用 `fulfillment.updated` 及终态 Webhook，并保留订单查询兜底。上游结果未知时不能取消或重复提交；明确失败且响应允许重提时，在原订单重新提交，展示代理商自己的充值入口，不泄露上游兑换码。

退差基准与实际美元成本是两个概念：前者按下单时约定冻结，后者须以该订单对应的已核实上游清算为准。平台退差不冲减代理基础分佣。核算或确认凭证不代表已经退款。

> 2026-09-28 重要说明：客户前端、订单链接和品牌页面由代理商自行开发，平台只提供后端 API。当前 GPT 成品统一由 CDK 支撑；创建订单时代理商可选 `delivery_mode=cdk`（直接交付公开号）或 `delivery_mode=auto_recharge`（平台服务端用订单绑定 CDK 自动兑换）。自动直充失败后只返回 `fallback_recharge_available=true`，由代理商自己的订单页重新显示提交入口，不返回明文 CDK，也不要求客户跳转平台品牌页。完整页面链路先阅读 [自有品牌商城与自动直充接入指南](https://tibo.ink/developers/partner-guide.md)。

版本：v1 生产接入版（2026-10-01 更新刷新与失败反馈规范）  
接口前缀：`/v1`；沙箱与生产使用不同域名、`partner_id`、密钥和数据。

## 0. 十分钟接入地图

按以下顺序接入，不要把密钥放进浏览器：

| 阶段 | 代理商动作 | 完成信号 |
|---|---|---|
| 1. API 凭证 | 代理主账号登录工作台创建服务端应用密钥 | 安全保存只显示一次的 `client_secret` |
| 2. 收款模式 | 零采购余额使用平台收款；需自收款时再充值采购余额 | `/v1/products` 返回当前可用模式和价格 |
| 3. 订单联调 | 服务端签名调用商品、下单和查单接口 | 获得 `order_id` 并查到支付状态 |
| 4. 交付验收 | 在代理商自有订单页调用自动直充或交付 CDK | 充值进入明确终态 |
| 5. 回调验收 | 校验 Webhook 签名并按事件 ID 去重 | 测试通知稳定返回 2xx |

API Origin 为 `https://tibo.ink`；下文路径均已包含 `/v1`，不要再重复拼接。沙箱接口地址由平台单独提供。代理商后端应把地址、`partner_id`、`key_id` 和 `client_secret` 放入环境配置；切换环境时必须整套切换，禁止混用。

可视化开发者中心：`https://你的生产域名/developers`。机器可读规范：`https://你的生产域名/developers/openapi.yaml`。

## 1. 接入准备

菲律宾 ChatGPT Pro 50x 一个月商品代码为 `chatgpt_pro_50x_cdk_1m`，当前供货价 3200 CNY。底层按 PH/PHP 签发 CDK，支持 `delivery_mode=cdk` 和 `delivery_mode=auto_recharge`，不增加新的接口。不要在前端硬编码可售状态或价格；四款商品均以 `GET /v1/products` 的实时结果为准，本次不开放美国、智利等地区选择。

2026-10-01 更新：代理商账号默认开放 API，无需提交申请、无需预存采购余额。代理主账号可直接在工作台创建服务端密钥。采购余额为 0 时仍可查询和创建平台收款订单，但系统强制 `collection_mode=platform_collect`，不得使用代理自收款/余额采购；余额充值到账后才可使用 `agent_collect`。管理员明确停用 API 时返回 403 `api_access_required`。

Quefa 为每个代理商开通：`partner_id`、应用 `app_id`、`key_id`、只显示一次的 `client_secret`、可选出口 IP 白名单、商品授权、供货价/销售上限、Webhook 地址与密钥。请勿在浏览器或移动端保存 `client_secret`，签名必须由代理商服务端完成。

调用拓扑必须是“买家浏览器 → 代理商服务端 → Quefa API”。浏览器只能调用代理商自己的后端，不能直接调用 Quefa；完整可运行示例见 `examples/partner-demo/`。

平台收款模式下，买家付款进入 Quefa，平台确认支付和执行零售退款。授权代理也可自行接支付，再使用 Quefa 采购余额支付供货价；此时平台订单 paid 仅表示采购款已扣，客户零售退款由代理自行处理。无论哪种模式，都不向 Quefa 配置代理支付宝私钥。API 凭证与支付凭证独立。自建兑换页、双模式字段与等级申请详见第 16 份开发指南。

金额请求/响应使用两位小数字符串，币种当前为 `CNY`。所有时间为 RFC 3339 UTC；签名时间戳为 Unix 秒。

## 2. 请求签名

必需请求头：

```http
X-Partner-Id: pt_demo
X-Key-Id: key_demo_01
X-Timestamp: 1790323200
X-Nonce: 8c86fc93-0830-4ba7-b3f3-c292cf4d83f4
X-Signature: 64位小写十六进制
Idempotency-Key: checkout_20260925_0001
Content-Type: application/json
```

`Idempotency-Key` 对 POST/PUT/PATCH/DELETE 必填，对 GET 为空字符串。将查询参数按“键和值分别 RFC 3986 百分号编码、按键再按值升序、使用 `&` 连接”生成 `CANONICAL_QUERY`，不要将 `+` 当作空格。签名串：

```text
METHOD\nPATH\nCANONICAL_QUERY\nTIMESTAMP\nNONCE\nKEY_ID\nIDEMPOTENCY_KEY\nSHA256_HEX(RAW_BODY)
```

然后计算：

```text
signature = lowercase_hex(HMAC-SHA256(client_secret, canonical_string_utf8))
```

文档示例的固定测试向量（时间戳、Nonce、请求体与三个示例程序一致）应得到：

```text
4590adec9a0d0980822e2b23425ce22081545f74c0a7f9886aa5d8419b7acce5
```

空请求体的 SHA-256 为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。JSON 必须先序列化一次，签名与 HTTP 发送使用完全相同的字节。服务端允许 ±300 秒；Nonce 10 分钟内不得复用。服务端返回 `X-Request-Id`，报障时请提供该值。

## 3. 幂等规则

- 同一代理商租户、路由和 `Idempotency-Key`，请求摘要一致：返回首次响应，`idempotent: true`。
- 同键但请求不同：HTTP 409 `idempotency_conflict`。
- 网络超时：使用相同幂等键重试；不要创建新键。
- 建议键由“业务类型 + 代理商订单号/退款号”构成，不含用户隐私。
- Quefa 至少保留幂等记录 7 天，财务动作永久以业务唯一号防重。

## 4. 商品

`GET /v1/products` 返回当前代理商已授权且可售商品、Quefa 供货价、销售上限、币种和单笔数量上限。不得使用其他代理商看到的商品或价格。

当前 GPT 成品的 `fulfillment_mode` 为 `cdk`，并通过 `delivery_modes` 告知代理商可选 `auto_recharge` 或 `cdk`。前者由平台服务端使用订单绑定凭证自动兑换，后者返回 `QF-` 公开号。代理商不需要、也不会获得平台内部账号、域名、履约参考号或原始兑换凭证。

```json
{
  "data": [{
    "product_code": "chatgpt_plus_cdk_1m",
    "name": "ChatGPT Plus 月卡",
    "supply_price": "110.00",
    "max_sale_price": "159.00",
    "currency": "CNY",
    "max_quantity": 1,
    "available": true,
    "fulfillment_mode": "cdk",
    "delivery_modes": ["auto_recharge", "cdk"]
  }]
}
```

## 5. 开单

`POST /v1/orders`：

```json
{
  "merchant_order_no": "M202609250001",
  "product_code": "chatgpt_plus_cdk_1m",
  "quantity": 1,
  "sale_amount": "135.00",
  "delivery_mode": "auto_recharge",
  "notify_url": "https://merchant.example.com/quefa/webhook",
  "metadata": {"cart_no": "C10086"}
}
```

成功返回 `order_id`、支付状态、过期时间、价格快照、`fulfillment_mode` 和 `delivery_mode`。正式代理网站应把客户留在自己的订单链接中；`metadata` 仅存代理商自己的非敏感标识，禁止传 Session、密码或证件信息。

`notify_url` 必须与 Quefa 为该代理商预登记的 Webhook 地址完全一致，不能按订单临时指定任意地址；生产必须使用 HTTPS，HTTP 仅允许隔离沙箱本机联调。

平台代收订单的支付入口由平台支付配置生成。代理商应在自己的页面展示付款按钮并轮询订单状态，不需要维护平台支付宝密钥。付款后继续使用代理商自己的订单链接；通过服务端调用 `/v1/redemptions` 提交自动直充，不把客户跳转到平台品牌页。

## 6. 查单与支付

`GET /v1/orders?payment_status=&cursor=&limit=` 分页查询当前代理商订单，默认每页 20 条、最大 100 条。`next_cursor` 为 `null` 表示没有下一页。代理商仍应在自己的数据库保存 `merchant_order_no ↔ order_id` 映射。

`GET /v1/orders/{order_id}` 返回订单价格快照、支付状态和退款金额口径；同时附带最近一次履约摘要字段：

- `fulfillment_status`：最近一次履约状态（`queued/running/succeeded/failed/cancelled`，无履约则为 `null`）
- `fulfillment_failure_code`：最近一次失败码；历史 `agent_cancelled` 仅兼容展示，当前不开放代理主动取消
- `retry_allowed`：仅最近一次尝试收到明确上游失败并已安全结束时为 `true`
- `sync_mark`：派生同步标记；充值已取消且订单已退款（含部分退款）时为 `cancelled_refunded`，其余为 `null`

履约尝试明细与退款详情仍分别调用对应接口查询。支付状态：

- `pending`：等待付款；
- `paid`：支付通道已确认；
- `expired`：未付款且已过期；
- `closed`：已关闭；
- `partially_refunded`：已有部分/补差退款；
- `refunded`：可退金额已全部退回。

代理商必须以该接口或验签后的 Webhook 为准，不得以用户页面跳转判断到账。建议前 2 分钟每 3 秒查询，之后逐步降低频率，总时长不超过订单有效期。代理商不需要登录或查询 Quefa 的支付宝后台。

## 7. 充值履约

推荐流程是由代理商页面展示付款入口；确认 `payment_status=paid` 后，在代理商自己的订单页收集本次授权凭据，再由代理商后端签名调用 `/v1/redemptions`。浏览器只调用代理商后端，平台密钥不得进入浏览器。

### 7.1 直接充值

`fulfillment_mode=direct` 时，客户打开 `fulfillment_url`，选择凭据类型并提交。Quefa 加密保存短期凭据、创建异步充值任务并在页面轮询结果。代理商通过 `GET /v1/orders/{order_id}/fulfillments` 或 Webhook 获取 `queued/running/succeeded/failed/cancelled` 稳定状态，并通过 `result_code/result_stage` 获取实际业务结果。

如果代理商经双方安全评审后确实需要服务端代提交，可调用下列接口；普通商城不要使用此方式，以免接触客户敏感凭据。

`POST /v1/orders/{order_id}/fulfillments` 仅允许已支付且未被退款锁定的订单：

```json
{
  "session_data": {
    "user": {"email": "buyer@example.com"},
    "accessToken": "仅示例，禁止使用真实值"
  },
  "customer_confirmed_email": true
}
```

该接口只接受 `direct` 商品，成功受理返回 `fulfillment_id` 和 `queued`。

### 7.2 CDK 与自动直充

`delivery_mode=cdk` 时，付款确认后平台异步生成 `voucher_code`，格式为 `品牌前缀-XXXXX-XXXXX-XXXXX-XXXXX`（随机部分为 20 位十六进制大写字符）。代理主账号可在「合作设置」修改 2–8 位字母数字前缀；仅影响新签发码，分组、长度和分隔符目前固定，代理商可直接交付客户。

`delivery_mode=auto_recharge` 时不返回 `voucher_code`。代理商后端调用 `/v1/redemptions`，请求 `mode=auto_recharge`、`order_id` 和本次客户授权凭据。仅收到明确上游失败、确认尝试已结束且允许重提时返回 `retry_allowed=true` 和 `fallback_recharge_available=true`，代理商自己的订单页重新开放输入入口；失败后仍不返回 CDK。

直接 CDK 模式下客户只看到代理品牌前缀的公开号。上游卡密在平台服务端加密保存，兑换成功后立即清除，任何代理商 API、客户页面、Webhook 和日志都不得返回上游卡密。

### 7.3 状态与失败码

| 失败码 | 建议处理 |
|---|---|
| `session_invalid` | 让用户重新登录并提交新 Session |
| `mailbox_login_failed` | 邮箱登录未通过；检查邮箱和密码，或改用 Session / Access Token。原任务明确失败且允许重提后，在原订单提交新资料 |
| `account_has_subscription` | 更换无有效订阅的账号或联系客服 |
| `precheck_rejected` | 按 `message` 提示处理账号预检问题，例如完成账号验证 |
| `subscription_required` | 当前商品要求账号已有有效订阅；更换账号或商品 |
| `account_unavailable` | 当前账号不可用于本次充值；更换账号后重新提交 |
| `product_unavailable` | 当前套餐暂不支持订购；停止提交并刷新商品目录 |
| `order_rejected` | 按 `message` 返回的实际业务原因处理，不要原单盲目重试 |
| `region_unsupported` | 更换受支持地区账号 |
| `payment_blocked` | 联系客服人工核查，不要重复提交同一 Session |
| `payment_declined` | 实际结果为最终拒付；停止轮询，可按商品策略重新提交 |
| `precharge_failed` | 扣款前校验失败；停止轮询并按提示处理 |
| `cancelled` | 充值在完成前被取消 |
| `verification_timeout` | 查询原任务并联系平台核对；不得因超时自行重提 |
| `service_unavailable` | Quefa 自动重试；代理商保持查询 |
| `other` | 携带 `request_id/fulfillment_id` 联系客服 |

状态未知时只查原任务，不要重复创建履约。代理无权主动取消排队或进行中任务；即使显示 failed/cancelled 也必须检查最近任务的 `retry_allowed`。仅其为 true 时，让客户修正资料并在原订单用新履约幂等键重提；网络重传必须沿用原键和原请求体。`next_action` 为 `wait/resubmit/none`。

`result_code` 保留实际结果语义：`queued/awaiting_card/funding_pending/dispatching/running/requires_action/pending/plus_paid/review` 均为非终态，必须继续查询；只有 `completed` 是成功，`declined/failed_precharge/cancelled` 是终态。不能把 `review`、网络超时或 HTTP 202 显示为失败。

平台按代理商配置字段级可见范围。Quefa 订单号、代理订单号、稳定状态、失败码与白标消息是基础字段；`result_stage`、实际用卡后四位、实际扣款金额/币种可由平台开放；内部履约参考号默认隐藏，只有平台显式授权时才返回。完整卡号、平台内部域名、原始兑换凭证、密钥和排障日志永不返回。API、代理工作台与 Webhook 使用同一字段策略。

### 7.4 进度与失败原因同步给代理商

代理商后端必须把查询到的充值进度、可公开的失败原因和可用动作同步到自己的工作台与客户订单页。当前主查询为 `GET /v1/redemptions/{redemption_id}`；也可用 `GET /v1/orders/{order_id}/fulfillments` 取得尝试记录。订单查询只含履约摘要，不含完整阶段和说明，不能只查付款状态就宣布充值完成。

| 字段 | 当前支持与使用方法 |
|---|---|
| `status` | 基础字段；`queued/running/succeeded/failed/cancelled` |
| `message` | 安全处理后的业务说明，可在代理品牌页展示；作为补充文案，不作为机器状态判断依据 |
| `failure_code` | 基础失败码；通过稳定码提示修正资料、联系支持或核查原任务 |
| `retry_allowed` | 最近尝试明确失败且可安全重提时为 true；不能由代理自行推断 |
| `next_action` | `wait/resubmit/none`；与最近尝试、支付和退款状态共同判断可用动作 |
| `fallback_recharge_available` | 任务查询提供的自动直充恢复标记；为 true 且允许重提时开放代理自有充值入口 |
| `result_code/result_stage` | 当前由平台按代理可见性配置开放；未返回时展示基础状态和 message |
| `attempt_no` | 原订单中的尝试序号；新尝试优先于旧尝试 |
| `progress_stage` | 默认公开的统一业务阶段；不依赖敏感结果字段的可见性配置 |
| `progress_version/progress_updated_at` | 同一尝试的公开进度版本及最后变化时间；重复查询不会增加版本，历史记录初始版本可为 0 |
| `recovery_action` | 平台选择的恢复方式：retry/refund/null；选择退款后不可重提 |
| `created_at/finished_at` | 尝试创建与完成时间 |

建议客户页面显示如下反馈：

| 已确认状态或阶段 | 页面文案与动作 |
|---|---|
| `queued` | 已提交，排队处理中；关闭重复提交按钮 |
| `logging_in` | 正在验证登录资料 |
| `preparing_funds/funding_pending` | 正在准备充值资源 |
| `awaiting_card/dispatching` | 正在安排充值 |
| `running`，无细分阶段 | 充值处理中 |
| `payment_review/pending/review` | 结果确认中；保留查询和客服入口，不重复提交 |
| `plus_paid` | 基础步骤已完成，升级处理中；仍非最终成功 |
| `requires_action` | 需要进一步确认；展示 API 已提供的安全说明，没有验证操作字段时联系支持 |
| `succeeded` | 充值成功，显示脱敏账号与完成时间 |
| `failed/cancelled` | 显示失败码对应原因和 message；按最新任务的重提条件显示恢复入口或联系支持 |

阶段字段可能缺失；不得模拟百分比、预计完成时间或未确认的步骤。网络查询失败显示“进度暂未更新，正在核对原任务”，保留最近成功数据，不能改成充值失败。`verification_timeout` 也不自动赋予重提权限。

前 2 分钟可每 3–5 秒查询同一任务，之后逐步退避到 15–30 秒；浏览器隐藏时降低或暂停页面轮询，代理后端继续必要的任务核对。页面还应提供“刷新进度”按钮，手动刷新仍查询原订单或原任务，不能创建新订单。每个任务只保留一个在途查询，同代理、同任务的多个页面共享后端短期读取结果，避免放大调用量。

这里的“实时反馈”是阶段变化通知加查询兜底，不是 WebSocket/SSE 逐秒推送，也不是每秒保证更新。平台当前正常处理的上游任务约每 5 秒核对一次；网络异常时延后重查，同步还受上游更新速度、任务数量和通知重试影响。代理商页面只显示最新已确认的 `progress_stage/message` 和 `progress_updated_at`，不能把“正在查询”显示为“充值成功”。

本版本新增 `fulfillment.updated`：任务受理及业务阶段、结果说明或恢复动作变化时写入持久化通知；相同状态轮询不重复推送。成功、失败和取消仍沿用 `fulfillment.succeeded/failed/cancelled`，这些事件也带同一套进度字段。平台部署本版本且你的回调订阅该事件或 `*` 后生效；旧服务器没有逐阶段事件，仍用查询兜底。

所有进度通知包含 `order_id/fulfillment_id/redemption_id/attempt_no/status/progress_stage/progress_version/progress_updated_at/message/failure_code/retry_allowed/next_action/recovery_action`。统一阶段为 `queued/logging_in/preparing_funds/awaiting_card/dispatching/processing/requires_action/confirming/review/upgrading/completed/failed/cancelled`，不包含上游身份、凭据或完整卡信息。不提供虚构的百分比。

接收端先验签、按 `event_id` 去重并持久化，再快速返回 2xx，由后台查单与查任务更新本站状态。同一任务仅接受更高的 `progress_version`；跨任务先比较原订单的 `attempt_no`，新尝试优先。失败通知必须把原因和动作同步给代理商；旧尝试、重复或乱序事件不能覆盖新状态。需要刷新页面、丢失通知或回调失败时，仍查询原任务，不能重新创建充值。

重新开放充值入口前确认原订单仍可履约、无退款锁定，并查询最新尝试。仅 `retry_allowed=true`、`next_action=resubmit`，且自动直充 `fallback_recharge_available=true` 时展示代理自己的输入页面或订单链接。修正资料后新尝试使用新幂等键；网络重传保留原键和原请求体。入口由代理商自行生成和鉴权，不能把平台订单号单独当作客户授权，也不向客户返回明文 CDK。

平台管理员也可取消确认尚未派发的任务，选择“允许重新提交”或“退款”。允许重提时保留原订单和原付款，不再次扣款；选择退款时锁定重提入口。平台代收走客户原路退款，代理自收采购只退采购余额，客户零售退款由代理自行处理。已派发、上游结果未知或已成功的任务不能通过本地强制取消绕过保护。代理商没有主动取消权限。

失败页面至少显示安全原因、本站订单号和下一步入口；代理工作台另保留 `order_id`、`redemption_id/fulfillment_id` 和最近请求的 `X-Request-Id` 便于排障。凭据、密钥、上游原始错误和内部 CDK 不进入客户反馈、Webhook、工单或日志。

### 7.5 可直接据此对接的进度和重提示例

#### 收到阶段变化通知

登记回调时订阅 `fulfillment.updated` 或 `*`。以下为通知正文示例；签名头及验签方法见第 10 节：

```json
{
  "event_id": "evt_example_progress_2",
  "event": "fulfillment.updated",
  "occurred_at": "2026-09-30T08:00:05.000Z",
  "data": {
    "event": "fulfillment.updated",
    "order_id": "ord_example",
    "fulfillment_id": "ful_attempt_1",
    "redemption_id": "ful_attempt_1",
    "attempt_no": 1,
    "status": "running",
    "progress_stage": "logging_in",
    "progress_version": 2,
    "progress_updated_at": "2026-09-30T08:00:05.000Z",
    "recovery_action": null,
    "message": "正在验证登录资料",
    "failure_code": null,
    "account_email_masked": null,
    "retry_allowed": false,
    "next_action": "wait"
  }
}
```

接收方按以下顺序实现：

1. 保留原始正文，校验 `X-Quefa-Timestamp` 和 `X-Quefa-Signature`，未经验证不能改变订单。
2. 按 `event_id` 幂等保存通知，快速返回 2xx，将后续查询放进你自己的后台队列。
3. 使用你的服务端签名查询 `GET /v1/orders/{order_id}` 与 `GET /v1/orders/{order_id}/fulfillments`，取 `attempt_no` 最大的当前尝试，再查 `GET /v1/redemptions/{id}`。不能把旧通知里的任务当成永远最新。
4. 当前尝试的阶段、原因和动作同步到你的状态接口，浏览器只调用你的后端。进度按尝试号和同尝试的版本去旧；退款、可重提与入口可用性必须另以最新查询核验，不能被相同版本的旧通知覆盖。

`fallback_recharge_available` 不保证出现在每条阶段通知里，恢复入口必须查询确认；回调不包含客户凭据，也不包含可直接访问的客户登录链接。客户入口由代理商自己的系统生成并鉴权。

#### 明确失败后重提原订单

最新任务查询返回 `status=failed|cancelled`、`retry_allowed=true`、`next_action=resubmit`，且自动直充 `fallback_recharge_available=true` 时，展示安全原因和「修正资料并重新提交」。再次提交示例：

```http
POST /v1/redemptions
Idempotency-Key: recharge:SHOP-20260930-0001:attempt-2
```

```json
{
  "mode": "auto_recharge",
  "order_id": "ord_example",
  "credential": {
    "mode": "session",
    "session": "<客户重新授权的完整 Session JSON>"
  },
  "customer_confirmed_email": true
}
```

其他 HMAC 签名头仍按第 3 节生成。这里的 `order_id` 与付款记录不变；新尝试使用新幂等键，受理返回 HTTP 202、新 `redemption_id` 和递增的 `attempt_no`。保存新任务号，关闭重复提交按钮，开始查新任务；不调用 `POST /v1/orders`、不再次付款、不向客户显示 CDK。若只是同一次提交的网络重传，应沿用原键和完全相同的请求体，另生成签名时间戳和 Nonce。

#### 平台管理员取消后：代理如何响应

代理无主动取消接口，也不调用后台管理接口。平台处理结果通过通知和查询同步：

| 最新查询结果 | 代理商必须实现的行为 |
|---|---|
| `recovery_action=retry`，且重提条件均满足 | 在自己的品牌订单页开放原订单输入入口；修正资料后按上例提交，不重新收款 |
| `recovery_action=refund` | 关闭输入和重提入口，显示「平台正在处理退款」；此时不是退款到账成功，不再创建另一笔退款 |
| `refund.succeeded` | 查原订单，并用 `GET /v1/refunds/{refund_id}` 核验退款结果，再更新客户退款状态 |
| `procurement.refunded` | 查原订单与 `GET /v1/wallet` 确认采购退款；只代表采购余额退回，代理自己收取的零售款仍由代理原渠道退给客户 |
| `queued/running`，或结果待确认、`retry_allowed=false` | 保留当前任务并继续查询；不能因超时、页面刷新或客户点击取消而另建任务 |

CDK 交付模式恢复时仍可由代理后端使用已购买的公开品牌码提交 `mode=cdk`；任务判断、新幂等键和退款互斥规则相同，上游原始码始终不对代理开放。

## 8. 退款与补差

`POST /v1/orders/{order_id}/refunds`：

```json
{
  "merchant_refund_no": "R202609250001",
  "type": "full",
  "amount": "135.00",
  "reason": "用户取消"
}
```

`type` 为 `full/partial/price_adjustment`。`price_adjustment` 表示上游实扣低于报价等场景下，平台向买家补退差价：**不改变履约成功事实，也不冲减代理商佣金**（差价由平台承担）；普通退款（`full`/`partial`）才会降低代理商销售差价与待结算额。申请状态：`requested/approved/processing/succeeded/failed/rejected/cancelled`。接口只受理，不承诺同步出款；Quefa 运营审核后，使用 Quefa 自有支付宝执行原路退款。代理商不能自行调用支付宝退款。

**推荐闭环（充值失败/取消后退款）：**

1. 上游明确失败且任务结束；未知结果、排队和进行中不可主动取消或普通退款；
2. 代理商调用 `POST /v1/orders/{order_id}/refunds` 申请普通退款（进行中、已成功或未经确认的失败会拒绝；允许退款时会锁定原码，不能同时重提）；
3. 平台财务在工作台「客户退款待审」同意 → 支付宝原路退回客户，并冲减该单代理佣金；
4. 收到验签后的 `refund.succeeded` 并查原单确认退款金额与状态后更新本站订单；不得仅依赖历史 `sync_mark`。

`GET /v1/refunds/{refund_id}` 查询最终结果。渠道超时保持 `processing` 并保留退款额度，后台按原退款号查询恢复；不重新申请另一笔退款。只有渠道确认成功才更新退款金额和账本。

平台另有独立的美元成本核算与成本节省补差记录。该记录不减少代理基础分佣；“直接退客户”与“退代理代退客户”互斥，且登记已付代理不等于客户收到。已进入该补差记录的订单不能再用旧 `price_adjustment` 路径重复申请；可能返回 `cost_adjustment_path_exists` 或 `cost_payment_conflict`，需联系平台核对现有记录。代理不能调用内部成本核验、付款登记接口，也不能据此自行转账。

订单提供 `notify_url` 时，仅投递到该代理已登记且启用的对应地址；未提供时兼容投递到该代理订阅事件的地址。公网回调拒绝内网、回环和云元数据地址；不会跟随重定向。

## 9. 账单与结算

- `GET /v1/ledger?from=&to=&cursor=`：代理商可见台账，包含买家向 Quefa 的付款、Quefa 供货价、退款、补差、代理商差价、待结算和结算划转；不返回支付密钥、Quefa 内部真实履约成本和 Quefa 毛利。
- `GET /v1/settlements`：结算单列表。
- `GET /v1/settlements/{settlement_id}`：结算汇总、明细、调整与打款信息。

结算单状态：`draft/reviewing/confirmed/paying/paid/failed`。结算对象是 Quefa 应付给代理商的销售差价，不是代理商向 Quefa 支付货款。封存后的结算单不会因后来退款而修改；相关退款在下一结算期显示为负向调整。若当期为负余额，将结转至后续周期或按合同另行处理。

## 10. Webhook

事件包括：`order.paid`、`order.expired`、`cdk.issued`、`fulfillment.updated`、`fulfillment.succeeded`、`fulfillment.failed`、`fulfillment.cancelled`、`refund.succeeded`、`refund.rejected`、`procurement.refunded`、`settlement.created`、`settlement.paid`、`webhook.test`。

订单对象新增只读同步字段：`fulfillment_status`、`fulfillment_failure_code`、`sync_mark`。当充值已取消（履约 `cancelled`，或失败码 `agent_cancelled`）且订单已退款时，`sync_mark=cancelled_refunded`。`refund.succeeded` 回调也会带上这三项，便于代理商侧直接关闭本地订单。

全额退款确认后，尚未派发的充值任务关闭，`recovery_action=refund`、`retry_allowed=false`、`next_action=none`，自动直充恢复入口关闭。已派发或结果未知的尝试仍须核对，不能把退款直接当成上游充值已取消。平台代收的支付宝退款退回原付款账户，不计入代理采购余额；差价退款仅用于部分价格调整，不用作全额取消退款。

```http
X-Quefa-Event: order.paid
X-Quefa-Event-Id: evt_01...
X-Quefa-Delivery: dlv_01...
X-Quefa-Timestamp: 1790323200
X-Quefa-Signature: t=1790323200,v1=<hex>
```

签名内容为 `timestamp + "." + 原始请求体字节`，使用独立 `webhook_secret` 做 HMAC-SHA256。先校验时间戳与签名，再以 `event_id` 作为业务去重键、`delivery_id` 作为投递尝试标识，最后返回 HTTP 2xx。建议先持久化后异步处理，5 秒内响应。投递失败按约 1、5、15、60、360 分钟及后续退避重试；代理商仍应定期主动对账。

## 11. 错误格式与常用错误码

```json
{
  "error": {
    "code": "order_not_found",
    "message": "订单不存在",
    "request_id": "req_01...",
    "retryable": false
  }
}
```

| HTTP | 错误码 | 含义/动作 |
|---|---|---|
| 400 | `invalid_request` | 修正字段，不重试原请求 |
| 401 | `invalid_signature` | 检查规范串、密钥和原始 body |
| 401 | `timestamp_out_of_range` | 同步 NTP 后重试 |
| 409 | `nonce_replayed` | 生成新 Nonce；业务幂等键不变 |
| 403 | `ip_not_allowed` | 联系 Quefa 更新白名单 |
| 403 | `product_not_authorized` | 代理商未获商品权限 |
| 404 | `order_not_found` | 订单不存在或不属于当前代理商 |
| 409 | `idempotency_conflict` | 同键请求内容不同，需排查 |
| 409 | `invalid_state_transition` | 当前状态不允许该动作 |
| 422 | `price_out_of_range` | 售价低于供货价或高于上限 |
| 429 | `rate_limited` | 按 `Retry-After` 退避 |
| 503 | `temporarily_unavailable` | 使用原幂等键退避重试 |

仅当 `retryable: true` 或 HTTP 429/502/503/504 时自动重试。建议指数退避 1、2、4、8、16 秒并加入 0~30% 抖动；支付/履约/退款未知结果优先查询，不盲目重提。

## 12. 沙箱与联调验收

沙箱使用 Quefa 提供的模拟支付和模拟充值服务，所有商品、订单、金额与生产隔离。代理商无需准备支付宝沙箱账号，不得把生产 API 密钥用于沙箱。验收项：

1. 正确签名成功；错误签名、过期时间戳、重放 Nonce 均被拒绝。
2. 同幂等键同请求重放一致；同键异请求返回冲突。
3. 商品授权和价格边界正确。
4. 创建订单、模拟支付、查单、Webhook 验签完成。
5. direct 充值成功、Quefa CDK 签发/兑换、Session 无效、服务超时与结果未知场景完成。
6. 普通退款、补差退款、重复退款和退款审核完成。
7. 验证 135/110 示例得到代理商差价 25 元；再发生 10 元 `price_adjustment` 后差价仍为 25 元；再发生 10 元普通退款后差价变为 15 元。
8. 验证结算后退款只进入下一期负向调整。
9. 使用另一代理商的订单/退款/结算 ID 访问全部失败。
10. 双方保存联调记录、联系人、出口 IP、回调地址和上线回滚方案。

机器可读定义见 `openapi/openapi.yaml`，Node.js/PHP/Python 签名示例见 `examples/signing/`，完整商城联调见 `examples/partner-demo/` 和 `docs/10-代理商沙箱联调指南.md`。
