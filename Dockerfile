# 悦安月子中心平台 —— 一键启动镜像
# 构建：docker build -t mooncare .
# 运行：docker run -p 3000:3000 mooncare
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# node:sqlite 需要 Node 22；构建期生成 .next
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# 数据库文件挂载点（首次启动自动建表 + 播种演示数据）
ENV MCARE_DB=/app/data/mcare.db
# 生产环境请通过该变量覆盖会话签名密钥
ENV MCARE_SECRET=change-me-in-production
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.mjs ./next.config.mjs
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["npm", "start"]
