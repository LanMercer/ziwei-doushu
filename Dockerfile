# syntax=docker/dockerfile:1
# ModelScope 创空间（Docker 类型）部署用镜像
# 关键点：创空间只放行 7860 端口，所以 next start 必须显式监听 7860。

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --registry=https://registry.npmmirror.com

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* 会在构建时被写进产物，所以站点地址要在 build 阶段给到。
# 平台支持构建参数时传 --build-arg NEXT_PUBLIC_SITE_URL=https://你的空间地址
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=7860
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.js ./next.config.js
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
EXPOSE 7860
CMD ["npx", "next", "start", "-p", "7860", "-H", "0.0.0.0"]
