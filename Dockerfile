# 悦安月子中心平台 · 一键启动镜像
# Node.js 22 内置 node:sqlite，无需外部数据库
FROM node:22-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# 1) 依赖（利用层缓存）
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# 2) 构建
COPY . .
RUN npm run build

# 3) 运行
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
# 数据库文件目录（建议挂载卷持久化）
RUN mkdir -p /app/data
CMD ["npm", "start"]
