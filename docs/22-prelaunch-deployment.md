# 从私有预部署切换到生产

本文记录旧 `compose.prelaunch.yaml` 环境如何安全切换到当前生产运行时。新部署直接使用 `compose.production.app.yaml`，不再把预发布模式作为正式运行方式。

## 旧环境边界

- 应用绑定服务器 `127.0.0.1:3200`，支付和履约固定 mock。
- SQLite 文件为 `/opt/recharge-platform/state/prelaunch.sqlite`。
- 管理账号和业务数据需要保留，但演示商户、演示应用与演示 API 密钥不能进入生产可用状态。

## 自动切换

```sh
sudo sh deploy/production/deploy-production-candidate.sh /opt/recharge-platform/releases/<release> <candidate-image>
```

脚本在停旧容器前建立一致性备份，停机后首次生成 `production.sqlite`，再启动生产容器。生产启动会自动撤销演示凭据并暂停演示商户；平台管理员账号保留，未完成 MFA 的账号会在首次生产登录时进入绑定流程。

切换失败会恢复旧软链接、旧镜像、旧环境文件和预发布容器。成功后不要删除 `prelaunch.sqlite` 与 `pre-production-*.sqlite`，至少保留到生产登录、MFA、支付设置、供应设置、开发者中心和备份任务全部验收完成。

## 生产初始状态

- `NODE_ENV=production`、`EXECUTION_MODE=production`。
- 支付适配器为后台托管模式，上游适配器为 ZovoCard。
- 支付宝和 DujiaoPay 没有已验证、已启用版本时不会建单收款。
- 供应连接没有生产凭据或仍为沙箱时不会派发真实充值。
- 不自动创建订单、付款、CDK 或充值任务，不调用任何资金写接口。

随后由平台管理员在 `admin.tibo.ink/workspace` 完成生产凭据配置、只读验证和逐通道启用。
