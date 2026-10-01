import {execFileSync} from "node:child_process";
import {readFileSync, statSync} from "node:fs";

const tracked = execFileSync("git", ["ls-files", "-z"], {encoding: "utf8"})
  .split("\0")
  .filter(Boolean)
  .map(path => path.replaceAll("\\", "/"));

const forbiddenPaths = [
  {pattern: /^(?:\.playwright-cli|artifacts|data|deployment-bundles|secrets)\//i, reason: "本地运行或敏感目录"},
  {pattern: /(?:^|\/)\.env(?:\..+)?$/i, reason: "环境文件", allow: path => path === ".env.example"},
  {pattern: /\.(?:db|key|p12|pfx|pem|sqlite)(?:-.+)?$/i, reason: "数据库或密钥文件"},
  {pattern: /\.(?:tar\.gz|tgz|zip)$/i, reason: "发布归档"},
];

const privateDocs = new Set([
  "docs/22-系统交接与优化建议.md",
  "docs/24-生产环境交接凭证.md",
  "docs/25-项目完整介绍.md",
  "docs/26-生产运维交接手册.md",
  "docs/28-20260929至0930完整交接.md",
  "docs/33-20260930代理资金与支付宝收款只读审计.md",
]);

const secretPatterns = [
  {pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, reason: "私钥正文"},
  {pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/, reason: "API 密钥"},
  {pattern: /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/, reason: "GitHub 令牌"},
  {pattern: /\b(?:LTAI|AKID)[A-Za-z0-9]{12,}\b/, reason: "云服务访问密钥"},
];

const violations = [];
for (const path of tracked) {
  if (privateDocs.has(path)) violations.push(`${path}: 内部交接文档禁止进入公开代码仓库`);
  for (const rule of forbiddenPaths) {
    if (rule.pattern.test(path) && !rule.allow?.(path)) violations.push(`${path}: ${rule.reason}禁止提交`);
  }
  const size = statSync(path).size;
  if (size > 5 * 1024 * 1024) violations.push(`${path}: 跟踪文件超过 5 MiB（${size} 字节）`);
  if (size === 0 || size > 2 * 1024 * 1024) continue;
  const content = readFileSync(path, "utf8");
  if (content.includes("\0")) continue;
  for (const rule of secretPatterns) {
    if (rule.pattern.test(content)) violations.push(`${path}: 检测到${rule.reason}`);
  }
}

if (violations.length) {
  console.error("仓库卫生检查失败：");
  for (const violation of [...new Set(violations)]) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`仓库卫生检查通过：${tracked.length} 个跟踪文件，无凭证、数据库、运行产物或超大文件。`);
}
