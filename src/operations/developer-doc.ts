import type {FastifyInstance} from "fastify";
import {readFileSync} from "node:fs";
import {brandFaviconLinks, quefaLogoMarkSvg, WORKSPACE_APP_URL} from "./brand-assets.js";

const DOC_PAGES = {
  integration: {title: "接入文档", subtitle: "Partner API 技术规范", file: "../../docs/partner-integration.md"},
  redemption: {title: "兑换指南", subtitle: "托管入口与自建兑换页", file: "../../docs/redemption-guide.md"},
  "payment-channels": {title: "支付通道说明", subtitle: "平台代收与余额采购", file: "../../docs/payment-channels.md"},
} as const;

type DocSlug = keyof typeof DOC_PAGES;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inlineMarkdown(text: string): string {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) => {
    const safe = href.startsWith("http") || href.startsWith("/") ? href : "#";
    const external = safe.startsWith("http") ? ' target="_blank" rel="noopener noreferrer"' : "";
    return `<a href="${escapeHtml(safe)}"${external}>${label}</a>`;
  });
  return html;
}

export function renderMarkdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        code.push(lines[i]!);
        i++;
      }
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      i++;
      continue;
    }
    if (/^\|.+\|$/.test(line) && i + 1 < lines.length && /^\|[-:| ]+\|$/.test(lines[i + 1]!)) {
      const header = line.split("|").slice(1, -1).map(cell => cell.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.+\|$/.test(lines[i]!)) {
        rows.push(lines[i]!.split("|").slice(1, -1).map(cell => cell.trim()));
        i++;
      }
      out.push(`<table><thead><tr>${header.map(cell => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const heading = line.match(/^(#{1,4}) (.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${inlineMarkdown(heading[2]!)}</h${level}>`);
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        quote.push(lines[i]!.replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote><p>${inlineMarkdown(quote.join(" "))}</p></blockquote>`);
      continue;
    }
    if (/^[-*] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*] /.test(lines[i]!)) {
        items.push(lines[i]!.slice(2));
        i++;
      }
      out.push(`<ul>${items.map(item => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>`);
      continue;
    }
    if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\d+\. /, ""));
        i++;
      }
      out.push(`<ol>${items.map(item => `<li>${inlineMarkdown(item)}</li>`).join("")}</ol>`);
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !lines[i]!.startsWith("```") && !/^(#{1,4}) /.test(lines[i]!) && !/^[-*] /.test(lines[i]!) && !/^\d+\. /.test(lines[i]!) && !/^>\s?/.test(lines[i]!) && !/^\|.+\|$/.test(lines[i]!) && !/^---+$/.test(lines[i]!.trim())) {
      para.push(lines[i]!);
      i++;
    }
    out.push(`<p>${inlineMarkdown(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

function docPageHtml(slug: DocSlug, bodyHtml: string): string {
  const page = DOC_PAGES[slug];
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${page.title} · Quefa 开发者中心</title>${brandFaviconLinks}<link rel="stylesheet" href="/developers/assets/portal.css"><link rel="stylesheet" href="/developers/assets/doc.css"></head>
<body class="doc-page"><header class="top doc-top"><div class="doc-top-start"><a class="back-workspace" href="${WORKSPACE_APP_URL}">← 返回工作台</a><a class="brand brand-inline" href="/developers">${quefaLogoMarkSvg("brand-mark", "quefa-q-doc")}<span>Quefa<small>开发者文档</small></span></a></div><div class="top-actions"><a class="quiet" href="/developers">开发者门户</a><a class="quiet" href="/developers/openapi.yaml">OpenAPI</a><a class="button" href="${WORKSPACE_APP_URL}">进入工作台</a></div></header>
<main class="doc-main"><nav class="doc-breadcrumb" aria-label="面包屑"><a href="${WORKSPACE_APP_URL}">工作台</a><span aria-hidden="true">/</span><a href="/developers">开发者中心</a><span aria-hidden="true">/</span><span aria-current="page">${page.title}</span></nav><header class="doc-head"><p class="eyebrow">${page.subtitle}</p><h1>${page.title}</h1></header><article class="doc-body">${bodyHtml}</article><footer class="doc-foot"><a class="button" href="${WORKSPACE_APP_URL}">← 返回工作台</a><a class="quiet" href="/developers">回到开发者门户</a></footer></main></body></html>`;
}

export const developerDocCss = `
.doc-page{background:var(--canvas)}.doc-top{gap:18px;justify-content:space-between}.doc-top-start{display:flex;align-items:center;gap:16px;min-width:0;flex-wrap:wrap}.back-workspace{display:inline-flex;align-items:center;min-height:38px;padding:0 14px;border:1px solid rgba(36,107,253,.24);border-radius:7px;background:#eef2ff;color:var(--signal);font-size:13px;font-weight:700;white-space:nowrap}.back-workspace:hover{background:#e0e7ff;color:var(--signal-deep)}.doc-main{max-width:920px;margin:0 auto;padding:28px clamp(20px,4vw,40px) 72px}.doc-breadcrumb{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:18px;color:var(--muted);font-size:12px}.doc-breadcrumb a{color:var(--ocean)}.doc-breadcrumb a:hover{color:var(--signal)}.doc-head{margin-bottom:28px;padding-bottom:22px;border-bottom:1px solid var(--line)}.doc-head h1{margin:10px 0 0;font-size:clamp(30px,4vw,40px);letter-spacing:-.04em}.doc-body{display:grid;gap:16px;color:var(--night);line-height:1.75}.doc-body h2,.doc-body h3,.doc-body h4{margin:18px 0 0;color:var(--night)}.doc-body h2{font-size:24px}.doc-body h3{font-size:18px}.doc-body p,.doc-body li{color:var(--secondary)}.doc-body ul,.doc-body ol{padding-left:22px;margin:0;display:grid;gap:8px}.doc-body blockquote{margin:0;padding:14px 16px;border-left:3px solid var(--signal);background:#f1f6fd;border-radius:0 8px 8px 0}.doc-body hr{border:0;border-top:1px solid var(--line);margin:8px 0}.doc-body table{width:100%;border-collapse:collapse;font-size:13px}.doc-body th,.doc-body td{padding:12px;border-bottom:1px solid var(--line);vertical-align:top;text-align:left}.doc-body th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}.doc-body code{font:600 12px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--ocean);overflow-wrap:anywhere}.doc-body pre{margin:0;padding:16px;border-radius:10px;background:var(--code);color:#dce9f8;overflow:auto}.doc-body pre code{color:inherit;font-weight:500;font-size:12px;line-height:1.7}.doc-body a{color:var(--signal)}.doc-foot{display:flex;gap:10px;flex-wrap:wrap;margin-top:40px;padding-top:24px;border-top:1px solid var(--line)}
@media(max-width:620px){.doc-top{align-items:flex-start;flex-direction:column}.doc-top-start{width:100%}.top-actions{width:100%;justify-content:flex-start;flex-wrap:wrap}}
`;

export function registerDeveloperDocs(app: FastifyInstance): void {
  app.get("/developers/assets/doc.css", async (_request, reply) => reply.type("text/css; charset=utf-8").send(developerDocCss));
  app.get<{Params: {slug: string}}>("/developers/doc/:slug", async (request, reply) => {
    const slug = request.params.slug as DocSlug;
    const page = DOC_PAGES[slug];
    if (!page) return reply.code(404).type("text/plain; charset=utf-8").send("文档不存在");
    const markdown = readFileSync(new URL(page.file, import.meta.url), "utf8");
    return reply.type("text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .header("content-security-policy", "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'")
      .header("x-content-type-options", "nosniff")
      .send(docPageHtml(slug, renderMarkdownToHtml(markdown)));
  });
}
