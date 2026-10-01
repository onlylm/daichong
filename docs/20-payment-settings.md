# 后台支付配置：支付宝

## 当前范围

平台代收只支持支付宝。USDT / DujiaoPay 不再开放新配置、新订单、收银页、回调或 Worker 任务；历史数据保留用于审计，不在后台形成可操作入口。

## 一次性部署准备

1. 使用独立 HTTPS 域名、独立 SQLite 数据库和服务账号；API 与 Worker 共享数据库和加密主密钥。
2. 正式运行设置 `NODE_ENV=production`、`EXECUTION_MODE=production`、`PAYMENT_PROVIDER=managed`、`FULFILLMENT_PROVIDER=zovocard`、`ENABLE_SANDBOX_ROUTES=false`、`LIVE_TEST_ENABLED=false`。
3. 更换 `DATA_ENCRYPTION_KEY` 以及平台管理、会话、页面令牌和代理 API 秘密。主密钥不得进入数据库备份。
4. 启动 API 和 Worker，初始化平台管理员；管理页置于 VPN/IP 访问控制后，支付宝回调路径须公网可达。
5. 新库的支付宝通道默认关闭，由管理员在“支付设置”保存、验证并启用。

从旧支付宝文件模式迁移时，若数据库存在绑定旧配置的未完结订单，须保留原 `ALIPAY_*` 参数和密钥，直到旧订单、退款及售后核对完成。

## 后台使用

支付设置仅平台管理员可访问，代理商不能读取或修改平台支付凭据。

1. 填写 APPID、收款商户 PID、PKCS8/PKCS1 应用私钥和支付宝公钥，保存为草稿。密钥加密持久化且不回显，空白表示保留旧密钥。
2. 验证 RSA 密钥格式和长度。该步骤不代表支付宝产品权限、回调连通或真实到账已经验证。
3. 在支付宝开放平台配置页面显示的回调地址，随后启用草稿。
4. 关闭通道后不再生成新付款码；已形成的支付事实仍按原支付宝订单验签、查单和入账。

每笔订单绑定创建时的支付配置版本。通知必须核对签名、APPID、PID、订单号、金额和交易号；浏览器跳转、截图或客户端声称均不能作为到账依据。

## 履约与财务边界

平台代收订单由支付宝确认后进入原订单、台账、CDK 和充值履约链路，不再扣代理采购余额。代理余额采购是独立模式，不受支付宝开关影响。

退款只允许沿原支付宝交易核对并入账。未确认或结果未知时保留原单查询，不创建替代付款，也不重复触发履约。

## 工作台接口

以下接口共用后台账号会话、同源检查和 CSRF：

- `GET /workspace/api/payment-settings`：读取支付宝脱敏状态；
- `PUT /workspace/api/payment-settings`：保存支付宝草稿；
- `POST /workspace/api/payment-settings/check`：验证密钥格式；
- `POST /workspace/api/payment-settings/enable`：启用已验证草稿；
- `POST /workspace/api/payment-settings/disable`：关闭支付宝。

后台通道编码固定为 `alipay_page`；代理接口通道编码固定为 `alipay`。

## 上线验证

所有自动测试使用临时数据库和模拟网关，不调用真实支付宝。生产发布前仍需进行最小金额真实收款、回调公网可达、退款回查、重复通知、晚到通知、订单关闭和账务一致性验收。
