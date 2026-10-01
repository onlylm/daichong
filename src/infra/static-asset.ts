import {gzipSync, brotliCompressSync, constants} from "node:zlib";
import {createHash} from "node:crypto";
import type {FastifyReply, FastifyRequest} from "fastify";

export function staticAssetHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function contentAddressedAssetPath(basePath: string, extension: string, content: string | Buffer): string {
  return `${basePath}.${staticAssetHash(content)}.${extension}`;
}

/** Precompress public code once at startup, never per request or for private financial responses. */
export function staticAsset(content: string, contentType: string, cacheControl = "public, max-age=31536000, immutable") {
  const identity=Buffer.from(content),gzip=gzipSync(identity,{level:9});
  const br=brotliCompressSync(identity,{params:{[constants.BROTLI_PARAM_QUALITY]:5}});
  const etag=`"${staticAssetHash(identity)}"`;
  return (request:FastifyRequest,reply:FastifyReply) => {
    const weights=new Map<string,number>();
    for (const item of (request.headers["accept-encoding"]??"").split(",")) {
      const [name,...params]=item.trim().toLowerCase().split(";");
      if (!name) continue;
      const qParam=params.map(s=>s.trim()).find(s=>s.startsWith("q="));
      const q=qParam?Number(qParam.slice(2)):1;
      weights.set(name,Number.isFinite(q)&&q>=0&&q<=1?q:0);
    }
    const quality=(name:string)=>weights.get(name)??weights.get("*")??0;
    const brQ=quality("br"),gzipQ=quality("gzip"),explicitIdentity=weights.get("identity");
    const encoding=brQ>0&&brQ>=gzipQ&&brQ>=(explicitIdentity??0)?"br":gzipQ>0&&gzipQ>=(explicitIdentity??0)?"gzip":null;
    reply.type(contentType).header("cache-control",cacheControl).header("etag",etag)
      .header("vary","Accept-Encoding").header("x-content-type-options","nosniff");
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();
    if (encoding) return reply.header("content-encoding",encoding).send(encoding==="br"?br:gzip);
    if (explicitIdentity===0 || (!weights.has("identity")&&weights.get("*")===0)) return reply.code(406).send();
    return reply.send(identity);
  };
}
