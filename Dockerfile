FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY scripts/verify-production-snapshot.mjs ./scripts/verify-production-snapshot.mjs
COPY docs/partner-integration.md ./docs/partner-integration.md
COPY docs/redemption-guide.md ./docs/redemption-guide.md
COPY docs/23-代理商自有品牌商城与自动直充接入指南.md ./docs/23-代理商自有品牌商城与自动直充接入指南.md
COPY docs/payment-channels.md ./docs/payment-channels.md
COPY openapi/openapi.yaml ./openapi/openapi.yaml
RUN mkdir -p /app/data && chown node:node /app/data
USER node
CMD ["node", "dist/server.js"]
