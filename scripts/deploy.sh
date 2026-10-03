#!/bin/sh
# =====================================================================
#  湘网组网 · 服务器一键部署脚本（Linux / 宝塔面板环境）
#  作用：检查环境 → 生成 .env（含随机强密码）→ 构建镜像 → 启动容器
#  用法：
#      sh scripts/deploy.sh                 # 默认端口 8080
#      HOST_PORT=9090 sh scripts/deploy.sh  # 自定义端口
#      CONSOLE_URL=https://mesh.example.com sh scripts/deploy.sh
# =====================================================================
set -eu

HOST_PORT="${HOST_PORT:-8080}"
CONSOLE_URL="${CONSOLE_URL:-}"
ET_VERSION="${ET_VERSION:-2.6.4}"

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

say()  { printf '\033[36m[湘网组网]\033[0m %s\n' "$1"; }
ok()   { printf '\033[32m[湘网组网]\033[0m %s\n' "$1"; }
warn() { printf '\033[33m[湘网组网]\033[0m %s\n' "$1"; }
die()  { printf '\033[31m[错误]\033[0m %s\n' "$1" >&2; exit 1; }

# ------------------------------ 环境检查 ------------------------------
say "检查环境 ..."

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  die "未找到 docker compose。请在宝塔「软件商店 → Docker 管理器」安装后重试。"
fi
docker info >/dev/null 2>&1 || die "无法连接 Docker 守护进程，请确认 Docker 服务已启动。"

TOTAL_MEM="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
[ "$TOTAL_MEM" -ge 700 ] || warn "可用内存偏低（${TOTAL_MEM}MB），首次构建可能较慢，建议先加 swap。"
ok "Docker 就绪（$DC）"

# ------------------------------ 生成 .env ------------------------------
if [ -f .env ]; then
  warn ".env 已存在，保留现有配置（如需重置请先手动删除）"
  # shellcheck disable=SC1091
  . ./.env
else
  say "生成 .env ..."
  if command -v openssl >/dev/null 2>&1; then
    PASS="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"
  else
    PASS="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-16)"
  fi

  cat > .env <<EOF
HOST_PORT=$HOST_PORT
CONSOLE_URL=$CONSOLE_URL
ADMIN_USER=admin
ADMIN_PASSWORD=$PASS
XW_VERSION=1.1.0
ET_VERSION=$ET_VERSION
TZ=Asia/Shanghai

AGENT_CONSOLE_URL=http://console:8080
NODE_RPC_PORT=15888
NODE_TOKEN=
ACCESS_KEY=
EOF
  chmod 600 .env
  ok "已生成 .env（管理员密码见下方输出）"
fi

mkdir -p data node-state

# ------------------------------ 构建启动 ------------------------------
say "构建镜像（首次约 2-5 分钟，取决于网络与服务器性能）..."
$DC build

say "启动容器 ..."
$DC up -d

# ------------------------------ 等待健康 ------------------------------
# HOST_PORT 可能写成 "8080" 或 "127.0.0.1:8080"，健康检查只取端口部分
REAL_PORT="${HOST_PORT##*:}"
say "等待控制台就绪（宿主端口 ${REAL_PORT}）..."
i=1
while [ "$i" -le 30 ]; do
  if curl -fsS -m 3 "http://127.0.0.1:${REAL_PORT}/api/health" >/dev/null 2>&1; then
    ok "控制台已就绪"
    break
  fi
  [ "$i" = "30" ] && warn "健康检查未通过，请执行：docker logs xiangwang-console --tail 50"
  i=$((i + 1))
  sleep 2
done

# ------------------------------ 结果输出 ------------------------------
IP="$(ip route get 1.1.1.1 2>/dev/null | awk '/src/ {for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -n1 || echo 服务器IP)"

echo
echo "  ─────────────────────────────────────────────"
echo "   湘网组网控制台部署完成"
echo "  ─────────────────────────────────────────────"
echo "   访问地址 : http://${IP}:${REAL_PORT}"
[ -n "${CONSOLE_URL:-}" ] && echo "   对外地址 : ${CONSOLE_URL}"
echo "   管理员   : ${ADMIN_USER:-admin}"
[ -n "${ADMIN_PASSWORD:-}" ] && echo "   初始密码 : ${ADMIN_PASSWORD}"
echo "   数据目录 : ${ROOT}/data"
echo "  ─────────────────────────────────────────────"
echo
echo "   登录后请立即在「工作区设置 → 修改密码」更换初始密码。"
echo "   常用命令："
echo "     docker logs -f xiangwang-console      # 查看日志"
echo "     docker compose restart console         # 重启控制台"
echo "     docker compose down                    # 停止（数据保留）"
echo
if [ -z "${CONSOLE_URL:-}" ]; then
  warn "尚未设置 CONSOLE_URL。用域名访问前请编辑 .env 填入 https://你的域名 并重启控制台，"
  warn "否则节点接入脚本回连地址会不正确。"
fi
echo
echo "   宝塔放行端口：${REAL_PORT}  （安全 → 防火墙 → 放行端口）"
echo "   若用面板 Nginx 反向代理，可改为绑定 127.0.0.1:${REAL_PORT} 只对内网暴露。"
echo
