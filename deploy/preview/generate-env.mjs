import {randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';

if(process.env.ISOLATED_PREVIEW!=='true')throw new Error('isolated_preview_required');
const directory=process.argv[2];
if(directory!=='/preview-config')throw new Error('preview_config_mount_required');
const secret=()=>randomBytes(32).toString('base64url');
const password=secret(),username='preview_admin';
const settings={NODE_ENV:'development',EXECUTION_MODE:'disabled',HOST:'0.0.0.0',PORT:'3200',LOG_LEVEL:'warn',
  STORAGE_DRIVER:'sqlite',SQLITE_PATH:'/app/data/preview.sqlite',PAYMENT_PROVIDER:'mock',FULFILLMENT_PROVIDER:'mock',
  PUBLIC_BASE_URL:'http://127.0.0.1:13200',ADMIN_BASE_URL:'http://127.0.0.1:13200',
  TRUST_PROXY:'false',ENABLE_SANDBOX_ROUTES:'false',LIVE_TEST_ENABLED:'false',REGISTRATION_ENABLED:'false',
  ZOVOCARD_API_BASE:'https://supplier.invalid/openapi/v1',ZOVOCARD_CDK_BASE:'https://supplier.invalid/api/v1/cdk',SUPPLIER_ALLOWED_HOSTS:'supplier.invalid',
  DATA_ENCRYPTION_KEY:randomBytes(32).toString('base64'),KEY_ENCRYPTION_KEY_ID:'isolated-preview-only',
  PORTAL_TOKEN_SECRET:secret(),PLATFORM_ADMIN_TOKEN:secret(),DEMO_CLIENT_SECRET:secret(),DEMO_WEBHOOK_SECRET:secret(),
  SANDBOX_ADMIN_TOKEN:secret(),DEMO_PARTNER_ID:'isolated_preview_demo',DEMO_KEY_ID:'isolated_preview_key',
  ISOLATED_PREVIEW:'true'};
writeFileSync(join(directory,'preview.env'),Object.entries(settings).map(([key,value])=>key+'='+value).join('\n')+'\n',{flag:'wx',mode:0o600});
writeFileSync(join(directory,'prepare.env'),Object.entries({...settings,PREVIEW_ADMIN_USERNAME:username,PREVIEW_ADMIN_PASSWORD:password}).map(([key,value])=>key+'='+value).join('\n')+'\n',{flag:'wx',mode:0o600});
writeFileSync(join(directory,'access.txt'),'仅用于本机 SSH 隧道访问的隔离验收环境，不是生产。\n入口：http://127.0.0.1:13200/workspace\n账号：'+username+'\n密码：'+password+'\n测试修改不回写正式数据；真实支付、充值、退款和回调均不可用。\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:'created',independentSecrets:true,productionSecretsUsed:false}));
