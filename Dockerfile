# =====================================================================
#  湘网组网 · 控制台镜像（多阶段构建）
#  阶段一：用 Node 22 构建 Vue 前端
#  阶段二：仅保留运行所需文件，静态托管前端 + 提供 API
# =====================================================================

# ---------- 阶段一：前端构建 ----------
# 必须用 glibc 基础镜像：Vite 依赖的 esbuild / rollup 没有 musl 构建产物，
# 在 alpine 上 `npm ci` 后 esbuild 找不到可执行文件会直接构建失败。
# 该阶段产物会被丢弃，镜像体积大一些无影响。
FROM node:22-slim AS web-builder
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci --registry=https://registry.npmmirror.com || npm install --registry=https://registry.npmmirror.com
COPY web/ ./
RUN npm run build

# ---------- 阶段二：运行镜像 ----------
# 运行期只有 express + cors（纯 JS），无原生依赖，可以用体积更小的 alpine
FROM node:22-alpine

# curl 供容器健康检查使用；tzdata 保证日志与审计时间正确
RUN apk add --no-cache curl tzdata \
 && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
 && echo "Asia/Shanghai" > /etc/timezone

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    TZ=Asia/Shanghai \
    XW_VERSION=1.1.0

# 后端依赖
COPY server/package*.json ./server/
RUN cd server && (npm ci --omit=dev --registry=https://registry.npmmirror.com || npm install --omit=dev --registry=https://registry.npmmirror.com)

# 后端源码与前端产物
COPY server/ ./server/
COPY --from=web-builder /app/web/dist ./web/dist

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "--experimental-sqlite", "server/src/index.js"]
