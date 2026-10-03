#!/bin/sh
# =====================================================================
#  湘网组网 · 容器节点入口
#  用途：让一台服务器以容器方式加入组网（区别于控制台容器）
#  特性：与控制台 /api/agent 保持一致 —— 心跳上报、流量统计、
#        配置版本同步、配置预检、密钥吊销联动下线
#  环境变量：
#    CONSOLE_URL   控制台地址（必填，如 https://mesh.example.com）
#    NODE_TOKEN    预置节点令牌（与 ACCESS_KEY 二选一）
#    ACCESS_KEY    接入密钥（与 NODE_TOKEN 二选一，容器首次启动自动注册）
#    RPC_PORT      核心 RPC 端口（默认 15888）
#    ET_VERSION    核心版本（默认 2.6.4）
#    SKIP_DOWNLOAD 设为 1 则跳过下载（镜像内已内置核心时使用）
# =====================================================================
set -eu

CONSOLE_URL="${CONSOLE_URL:-}"
NODE_TOKEN="${NODE_TOKEN:-}"
ACCESS_KEY="${ACCESS_KEY:-}"
RPC_PORT="${RPC_PORT:-15888}"
ET_VERSION="${ET_VERSION:-2.6.4}"
HEARTBEAT_INTERVAL="${HEARTBEAT_INTERVAL:-30}"
SKIP_DOWNLOAD="${SKIP_DOWNLOAD:-0}"

STATE_DIR=/var/lib/xiangwang
CFG="$STATE_DIR/config.toml"
DEV_NAME_DEFAULT=xwtun0

say()  { printf '\033[36m[湘网组网]\033[0m %s\n' "$1"; }
ok()   { printf '\033[32m[湘网组网]\033[0m %s\n' "$1"; }
warn() { printf '\033[33m[湘网组网]\033[0m %s\n' "$1"; }
die()  { printf '\033[31m[错误]\033[0m %s\n' "$1" >&2; exit 1; }

[ -n "$CONSOLE_URL" ] || die "缺少 CONSOLE_URL（控制台对外地址）"
[ -n "$NODE_TOKEN$ACCESS_KEY" ] || die "缺少 NODE_TOKEN 或 ACCESS_KEY，请在控制台生成后填入"

mkdir -p "$STATE_DIR"

# ------------------------------ 架构识别 ------------------------------
case "$(uname -m)" in
  x86_64|amd64)  ARCH=x86_64 ;;
  aarch64|arm64) ARCH=aarch64 ;;
  armv7l)        ARCH=armv7hf ;;
  armv7)         ARCH=armv7hf ;;
  armhf)         ARCH=armhf ;;
  riscv64)       ARCH=riscv64 ;;
  *)             die "未识别的架构：$(uname -m)" ;;
esac

# ------------------------------ 核心程序 ------------------------------
if [ ! -x /usr/local/bin/easytier-core ] && [ "$SKIP_DOWNLOAD" != "1" ]; then
  PKG="easytier-linux-${ARCH}-v${ET_VERSION}.zip"
  RAW="https://github.com/EasyTier/EasyTier/releases/download/v${ET_VERSION}/${PKG}"
  say "下载组网核心（$ARCH / v$ET_VERSION）..."
  cd /tmp
  curl -fL --connect-timeout 20 -o "$PKG" "$RAW" 2>/dev/null \
    || curl -fL --connect-timeout 20 -o "$PKG" "https://ghfast.top/${RAW}" 2>/dev/null \
    || curl -fL --connect-timeout 20 -o "$PKG" "https://gh-proxy.com/${RAW}" 2>/dev/null \
    || die "核心下载失败，请手动下载 $PKG 放入 /usr/local/bin 后重试"
  unzip -o -q "$PKG" -d /tmp/et-core
  SRC="$(find /tmp/et-core -type f -name easytier-core | head -n1)"
  [ -n "$SRC" ] || die "压缩包内未找到 easytier-core"
  cp "$(dirname "$SRC")"/easytier-* /usr/local/bin/
  chmod +x /usr/local/bin/easytier-*
  rm -rf /tmp/et-core "/tmp/$PKG"
fi
[ -x /usr/local/bin/easytier-core ] || die "未找到 /usr/local/bin/easytier-core"

# ------------------------------ 领取身份 ------------------------------
HOSTNAME_R="$(hostname 2>/dev/null || echo xw-container)"
REPORTED_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '/src/ {for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -n1 || true)"

if [ -z "$NODE_TOKEN" ]; then
  # 已注册过就复用（容器重启不重复占号）
  if [ -s "$STATE_DIR/token" ]; then
    NODE_TOKEN="$(cat "$STATE_DIR/token")"
    say "复用已保存的节点身份"
  else
    say "使用接入密钥注册本机 ..."
    REG="$(curl -sS -m 20 -G "$CONSOLE_URL/api/agent/register" \
        --data-urlencode "key=$ACCESS_KEY" \
        --data-urlencode "hostname=$HOSTNAME_R" \
        --data-urlencode "arch=$ARCH" \
        --data-urlencode "platform=docker" \
        --data-urlencode "reportedIp=$REPORTED_IP" 2>/dev/null || true)"
    echo "$REG" | grep -q '^NODE_TOKEN=' || {
      echo "$REG" >&2
      die "注册失败（密钥可能已吊销、过期或已达设备上限），请回控制台确认"
    }
    NODE_TOKEN="$(echo "$REG" | sed -n 's/^NODE_TOKEN=//p' | head -n1)"
    ok "已分配虚拟 IP：$(echo "$REG" | sed -n 's/^VIRTUAL_IP=//p' | head -n1)"
  fi
fi
printf '%s\n' "$NODE_TOKEN" > "$STATE_DIR/token"
chmod 600 "$STATE_DIR/token"

# ------------------------------ 拉取配置 ------------------------------
toml_ok() { [ -s "$1" ] && grep -q 'network_identity' "$1"; }

fetch_config() {
  curl -fsS -m 20 -o "$1" "$CONSOLE_URL/api/agent/config?token=$NODE_TOKEN" 2>/dev/null || true
}

if ! toml_ok "$CFG"; then
  say "从控制台拉取节点配置 ..."
  fetch_config "$CFG.new"
  if toml_ok "$CFG.new"; then
    mv "$CFG.new" "$CFG"
  else
    rm -f "$CFG.new"
    die "无法获取节点配置，请检查 CONSOLE_URL 与网络连通性：$CONSOLE_URL"
  fi
fi
chmod 600 "$CFG"

preflight() {
  command -v timeout >/dev/null 2>&1 || return 0
  rc=0
  timeout 8 /usr/local/bin/easytier-core -c "$1" >"$STATE_DIR/preflight.log" 2>&1 || rc=$?
  case "$rc" in 124|143|130) return 0 ;; *) return 1 ;; esac
}

say "校验节点配置 ..."
if ! preflight "$CFG"; then
  echo "---------- 预检输出 ----------" >&2
  tail -n 25 "$STATE_DIR/preflight.log" >&2 || true
  echo "-----------------------------" >&2
  die "配置校验未通过，核心程序拒绝启动。请把上面的输出反馈给管理员。"
fi
ok "配置校验通过"

# ------------------------------ 心跳上报 ------------------------------
dev_name_of() {
  sed -n 's/^ *dev_name *= *"\(.*\)"/\1/p' "$CFG" 2>/dev/null | head -n1
}

report_heartbeat() {
  CORE_VERSION="$(/usr/local/bin/easytier-core --version 2>/dev/null | awk '{print $2}')"

  PEER_COUNT=0
  if [ -x /usr/local/bin/easytier-cli ]; then
    RAW="$(/usr/local/bin/easytier-cli -p "127.0.0.1:${RPC_PORT}" peer 2>/dev/null || true)"
    if [ -n "$RAW" ]; then
      PEER_COUNT="$(printf '%s\n' "$RAW" | grep -c '^|' || true)"
      if [ "${PEER_COUNT:-0}" -gt 0 ] 2>/dev/null; then
        PEER_COUNT=$((PEER_COUNT - 1))
      else
        PEER_COUNT=0
      fi
    fi
  fi

  RX=0; TX=0
  if [ -r /proc/net/dev ]; then
    DEV="$DEV_NAME_DEFAULT"
    D="$(dev_name_of)"
    [ -n "$D" ] && DEV="$D"
    STAT="$(awk -v d="${DEV}:" '$1==d {print $2" "$10}' /proc/net/dev 2>/dev/null || true)"
    if [ -n "$STAT" ]; then
      RX="$(echo "$STAT" | awk '{print $1}')"
      TX="$(echo "$STAT" | awk '{print $2}')"
    fi
  fi

  HOSTNAME_R="$(hostname 2>/dev/null || echo xw-container)"
  PLATFORM="$(uname -s -m 2>/dev/null || echo unknown)"
  REPORTED_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '/src/ {for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -n1 || true)"

  RESP="$(curl -s -m 15 -X POST "$CONSOLE_URL/api/agent/heartbeat" \
    -H 'Content-Type: application/json' \
    -d "{\"token\":\"$NODE_TOKEN\",\"hostname\":\"$HOSTNAME_R\",\"coreVersion\":\"$CORE_VERSION\",\"peerCount\":${PEER_COUNT:-0},\"platform\":\"docker\",\"reportedIp\":\"$REPORTED_IP\",\"rxBytes\":${RX:-0},\"txBytes\":${TX:-0}}" \
    2>/dev/null || true)"

  case "$RESP" in
    *'"revoked":true'*) return 1 ;;
  esac
  return 0
}

# ------------------------------ 核心守护 ------------------------------
CORE_PID=""
start_core() {
  /usr/local/bin/easytier-core -c "$CFG" &
  CORE_PID=$!
}

stop_core() {
  [ -n "$CORE_PID" ] || return 0
  kill "$CORE_PID" 2>/dev/null || true
  wait "$CORE_PID" 2>/dev/null || true
  CORE_PID=""
}

SHUTTING_DOWN=0
on_term() {
  SHUTTING_DOWN=1
  say "收到退出信号，正在关闭 ..."
  stop_core
  exit 0
}
trap on_term TERM INT

say "启动组网核心 ..."
start_core
ok "容器节点已启动，进入心跳与配置同步循环"

# ------------------------------ 主循环 ------------------------------
FIRST=1
while [ "$SHUTTING_DOWN" = "0" ]; do
  [ "$FIRST" = "1" ] && FIRST=0 || sleep "$HEARTBEAT_INTERVAL"

  # 核心进程意外退出 → 拉起（配置问题则等下一轮同步换配置）
  if [ -n "$CORE_PID" ] && ! kill -0 "$CORE_PID" 2>/dev/null; then
    warn "核心进程已退出，10 秒后重启 ..."
    CORE_PID=""
    sleep 10
    start_core
  fi

  # 令牌被吊销 / 设备被停止 → 主动下线
  if ! report_heartbeat; then
    warn "控制台已吊销本节点身份，容器进入停止状态。"
    stop_core
    exit 0
  fi

  # 配置同步
  if fetch_config "$CFG.new" && toml_ok "$CFG.new" && ! cmp -s "$CFG.new" "$CFG"; then
    if preflight "$CFG.new"; then
      cp "$CFG" "$STATE_DIR/config.bak"
      mv "$CFG.new" "$CFG"
      chmod 600 "$CFG"
      stop_core
      start_core
      ok "配置已更新（版本 v$(sed -n 's/.*CONFIG_VERSION=//p' "$CFG" | tr -d '[:space:]')），核心已重启"
    else
      warn "新配置预检未通过，保持当前配置运行（详见 $STATE_DIR/preflight.log）"
      rm -f "$CFG.new"
    fi
  fi
  rm -f "$CFG.new"
done
