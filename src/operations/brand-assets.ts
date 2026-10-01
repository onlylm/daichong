import type {FastifyInstance} from "fastify";

export const WORKSPACE_APP_URL = "/workspace/app?view=docs";

/** Minimal tech “Q” node mark — deep navy → tech blue gradient plate. */
export const quefaLogoMarkSvg = (className = "brand-mark", gradientId = "quefa-q") => `<svg class="${className}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true"><defs><linearGradient id="${gradientId}" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse"><stop stop-color="#10243d"/><stop offset=".52" stop-color="#173f71"/><stop offset="1" stop-color="#246bfd"/></linearGradient></defs><rect width="32" height="32" rx="9" fill="url(#${gradientId})"/><circle cx="24" cy="8" r="2" fill="#75d6f3"/><path d="M10.5 16a5.5 5.5 0 1 1 11 0 5.5 5.5 0 0 1-11 0" stroke="#fff" stroke-width="2.25" stroke-linecap="round"/><path d="M19.5 19.5 23.5 23.5" stroke="#75d6f3" stroke-width="2.25" stroke-linecap="round"/></svg>`;

/** Favicon source — simplified Q without plate for small sizes. */
export const quefaFaviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="f" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse"><stop stop-color="#10243d"/><stop offset="1" stop-color="#246bfd"/></linearGradient></defs><rect width="32" height="32" rx="7" fill="url(#f)"/><path d="M9 16a7 7 0 1 1 14 0 7 7 0 0 1-14 0" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><path d="M20 20l5 5" stroke="#75d6f3" stroke-width="2.6" stroke-linecap="round"/></svg>`;

export const quefaLogoStackHtml = `<div class="brand brand-stack">${quefaLogoMarkSvg("brand-mark brand-mark-lg", "quefa-q-lg")}<div class="brand-wordmark"><strong>Quefa</strong><span>开放平台</span></div></div>`;

const faviconIco = Buffer.from("AAABAAEAEBAAAAEAIABoBAAAFgAAACgAAAAQAAAAIAAAAAEAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA9JBD/PSQQ/z0kEP89JBD/PSQQ/z0kEP89JBD/PSQQ/6JBHv89JBD/PSQQ/z0kEP89JBD/PSQQ/z0kEP89JBD/PSQQ/z0kEP89JBD/PSQQ/z0kEP+QPBz/lT0d/////////////////6ZCH/+qQyD/PSQQ/z0kEP89JBD/PSQQ/z0kEP89JBD/PSQQ/z0kEP+HORv/////////////////////////////////89Z1//PWdf89JBD/PSQQ/z0kEP89JBD/PSQQ/z0kEP9/Nxn/////////////////////////////////89Z1//PWdf/z1nX/89Z1/z0kEP89JBD/PSQQ/z0kEP92NBj/////////////////hzkb/4w7G/+QPBz/lT0d//PWdf/z1nX/89Z1//PWdf+qQyD/PSQQ/z0kEP89JBD/cjMY////////////fzcZ/4M4Gv+HORv/jDsb/5A8HP+VPR3/89Z1//PWdf//////pkIf/z0kEP89JBD/PSQQ/////////////////3o2Gf9/Nxn/gzga/4c5G/+MOxv/kDwc/5U9Hf////////////////89JBD/PSQQ/2QvFv////////////////92NBj/ejYZ/383Gf+DOBr/hzkb/4w7G/+QPBz/////////////////okEe/z0kEP89JBD/////////////////cjMY/3Y0GP96Nhn/fzcZ/4M4Gv+HORv/jDsb/////////////////z0kEP89JBD/PSQQ/2AuFf///////////20yF/9yMxj/djQY/3o2Gf9/Nxn/gzga/4c5G////////////5U9Hf89JBD/PSQQ/z0kEP9cLRT/////////////////bTIX/3IzGP92NBj/ejYZ/383Gf////////////////+QPBz/PSQQ/z0kEP89JBD/PSQQ/1wtFP////////////////////////////////////////////////+HORv/PSQQ/z0kEP89JBD/PSQQ/z0kEP89JBD/XC0U//////////////////////////////////////9/Nxn/PSQQ/z0kEP89JBD/PSQQ/z0kEP89JBD/PSQQ/z0kEP9cLRT/YC4V/////////////////3IzGP92NBj/PSQQ/z0kEP89JBD/PSQQ/z0kEP89JBD/PSQQ/z0kEP89JBD/PSQQ/z0kEP89JBD/ZC8W/z0kEP89JBD/PSQQ/z0kEP89JBD/PSQQ/z0kEP89JBD/PSQQ/z0kEP89JBD/PSQQ/z0kEP89JBD/PSQQ/z0kEP89JBD/PSQQ/z0kEP89JBD/PSQQ/z0kEP89JBD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==", "base64");

export function registerBrandAssets(app: FastifyInstance): void {
  app.get("/favicon.svg", async (_request, reply) => reply.type("image/svg+xml; charset=utf-8")
    .header("cache-control", "public, max-age=86400")
    .send(quefaFaviconSvg));
  app.get("/favicon.ico", async (_request, reply) => reply.type("image/x-icon")
    .header("cache-control", "public, max-age=86400")
    .send(faviconIco));
  app.get("/brand/logo-mark.svg", async (_request, reply) => reply.type("image/svg+xml; charset=utf-8")
    .header("cache-control", "public, max-age=86400")
    .send(quefaLogoMarkSvg("brand-mark", "quefa-q-file")));
}

export const brandFaviconLinks = `<link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" href="/favicon.svg" type="image/svg+xml">`;
