# ---------- 前端构建 ----------
FROM node:22-alpine AS web-builder
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci --registry=https://registry.npmmirror.com || npm install --registry=https://registry.npmmirror.com
COPY web/ ./
RUN npm run build

# ---------- 运行镜像 ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data

COPY server/package*.json ./server/
RUN cd server && (npm ci --omit=dev --registry=https://registry.npmmirror.com || npm install --omit=dev --registry=https://registry.npmmirror.com)

COPY server/ ./server/
COPY --from=web-builder /app/web/dist ./web/dist

VOLUME ["/data"]
EXPOSE 8080

CMD ["node", "--experimental-sqlite", "server/src/index.js"]
