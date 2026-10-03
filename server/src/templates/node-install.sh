#!/bin/sh
# =====================================================================
#  湘网组网 · 节点接入脚本
#  支持两种模式：
#    A. 预置节点：脚本已内置令牌，直接执行即可
#    B. 接入密钥：脚本在设备上调用控制台领取身份（key 模式）
#  使用：sudo sh xiangwang-node.sh
# =====================================================================
set -eu

CONSOLE_URL="{{CONSOLE_URL}}"
NODE_TOKEN="{{NODE_TOKEN}}"
ACCESS_KEY="{{ACCESS_KEY}}"
ET_VERSION="{{ET_VERSION}}"
RPC_PORT="{{RPC_PORT}}"

INSTALL_DIR="/opt/xiangwang"
STATE_DIR="$INSTALL_DIR/state"
SERVICE="xiangwang-node"
AGENT_SERVICE="xiangwang-agent"
AGENT_UNIT="/etc/systemd/system/${AGENT_SERVICE}.service"
AGENT_TIMER="/etc/systemd/system/${AGENT_SERVICE}.timer"

say()  { printf '\033[36m[湘网组网]\033[0m %s\n' "$1"; }
ok()   { printf '\033[32m[湘网组网]\033[0m %s\n' "$1"; }
warn() { printf '\033[33m[湘网组网]\033[0m %s\n' "$1"; }
die()  { printf '\033[31m[错误]\033[0m %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "请用 root 权限运行（sudo sh $0）"
command -v systemctl >/dev/null 2>&1 || die "当前环境没有 systemd。Docker 场景请直接使用控制台里的 docker run 命令。"
[ -n "$CONSOLE_URL" ] || die "脚本未内置控制台地址，请回控制台重新生成"

# ------------------------------ 架构识别 ------------------------------
case "$(uname -m)" in
  x86_64|amd64)  ARCH=x86_64 ;;
  aarch64|arm64) ARCH=aarch64 ;;
  armv7l)        ARCH=armv7 ;;
  armv7)         ARCH=armv7hf ;;
  armhf)         ARCH=armhf ;;
  mips)          ARCH=mips ;;
  mipsel)        ARCH=mipsel ;;
  arm*)          ARCH=arm ;;
  riscv64)       ARCH=riscv64 ;;
  *)             die "未识别的架构：$(uname -m)" ;;
esac

# ------------------------------ 依赖准备 ------------------------------
command -v curl >/dev/null 2>&1 || {
  say "安装 curl ..."
  (apt-get update -qq && apt-get install -y -qq curl) \
    || (yum install -y -q curl) \
    || (apk add --no-cache curl) \
    || die "请先手动安装 curl 后重试"
}
command -v unzip >/dev/null 2>&1 || {
  say "安装 unzip ..."
  (apt-get update -qq && apt-get install -y -qq unzip) \
    || (yum install -y -q unzip) \
    || (apk add --no-cache unzip) \
    || die "请先手动安装 unzip 后重试"
}

mkdir -p "$INSTALL_DIR/bin" "$STATE_DIR"
chmod 700 "$INSTALL_DIR"

# ------------------------------ 下载核心 ------------------------------
if [ ! -x "$INSTALL_DIR/bin/easytier-core" ]; then
  PKG="easytier-linux-${ARCH}-v${ET_VERSION}.zip"
  URL="https://github.com/EasyTier/EasyTier/releases/download/v${ET_VERSION}/${PKG}"
  say "下载核心程序（$ARCH / v$ET_VERSION）..."
  cd "$INSTALL_DIR"
  curl -fL --connect-timeout 20 -o "$PKG" "$URL" 2>/dev/null \
    || curl -fL --connect-timeout 20 -o "$PKG" "https://ghfast.top/${URL}" 2>/dev/null \
    || die "下载失败，请手动下载 $PKG 放入 $INSTALL_DIR 后重试"
  unzip -o -q "$PKG" -d "$INSTALL_DIR/bin"
  CORE="$(find "$INSTALL_DIR/bin" -type f -name easytier-core | head -n1)"
  [ -n "$CORE" ] || die "压缩包内未找到 easytier-core"
  cp "$(dirname "$CORE")"/easytier-* "$INSTALL_DIR/bin/"
  chmod +x "$INSTALL_DIR/bin/"easytier-*
  rm -f "$PKG"
fi
CORE_BIN="$INSTALL_DIR/bin/easytier-core"

# ------------------------------ 领取身份 ------------------------------
HOSTNAME_R="$(hostname 2>/dev/null || echo unknown)"
REPORTED_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '/src/ {for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -n1 || true)"

if [ -z "$NODE_TOKEN" ]; then
  [ -n "$ACCESS_KEY" ] || die "脚本既没有节点令牌也没有接入密钥，请回控制台重新生成"
  say "正在使用接入密钥向控制台注册本机 ..."
  REG="$(curl -sS -m 20 -G "$CONSOLE_URL/api/agent/register" \
      --data-urlencode "key=$ACCESS_KEY" \
      --data-urlencode "hostname=$HOSTNAME_R" \
      --data-urlencode "arch=$ARCH" \
      --data-urlencode "reportedIp=$REPORTED_IP" 2>/dev/null || true)"
  echo "$REG" | grep -q '^NODE_TOKEN=' || {
    echo "$REG" >&2
    die "注册失败（密钥可能已吊销、过期或已达设备上限），请回控制台确认"
  }
  NODE_TOKEN="$(echo "$REG" | sed -n 's/^NODE_TOKEN=//p' | head -n1)"
  NODE_NAME_R="$(echo "$REG" | sed -n 's/^NODE_NAME=//p' | head -n1)"
  VIRTUAL_IP_R="$(echo "$REG" | sed -n 's/^VIRTUAL_IP=//p' | head -n1)"
  NETWORK_NAME_R="$(echo "$REG" | sed -n 's/^NETWORK_NAME=//p' | head -n1)"
  ok "已分配虚拟 IP：$VIRTUAL_IP_R"
else
  NODE_NAME_R="{{NODE_NAME}}"
  VIRTUAL_IP_R="{{VIRTUAL_IP}}"
  NETWORK_NAME_R="{{NETWORK_NAME}}"
fi

cat > "$INSTALL_DIR/config.env" <<XW_ENV_EOF
CONSOLE_URL=$CONSOLE_URL
NODE_TOKEN=$NODE_TOKEN
RPC_PORT=$RPC_PORT
XW_ENV_EOF
chmod 600 "$INSTALL_DIR/config.env"

# ------------------------------ 配置文件 ------------------------------
cat > "$INSTALL_DIR/config.toml" <<'XW_CFG_EOF'
{{NODE_CONFIG_TOML}}
XW_CFG_EOF

toml_ok() {
  [ -s "$1" ] && grep -q 'network_identity' "$1"
}

if ! toml_ok "$INSTALL_DIR/config.toml"; then
  say "正在从控制台拉取节点配置 ..."
  curl -fsS -m 20 -o "$INSTALL_DIR/config.toml.new" \
    "$CONSOLE_URL/api/agent/config?token=$NODE_TOKEN" 2>/dev/null || true
  if toml_ok "$INSTALL_DIR/config.toml.new"; then
    mv "$INSTALL_DIR/config.toml.new" "$INSTALL_DIR/config.toml"
  else
    rm -f "$INSTALL_DIR/config.toml.new"
    die "无法获取节点配置，请检查控制台地址与网络连通性：$CONSOLE_URL"
  fi
fi
chmod 600 "$INSTALL_DIR/config.toml"

# 配置预检：以新配置试跑 8 秒，能存活说明配置合法
preflight() {
  command -v timeout >/dev/null 2>&1 || return 0
  rc=0
  timeout 8 "$CORE_BIN" -c "$1" >"$STATE_DIR/preflight.log" 2>&1 || rc=$?
  [ "$rc" = "124" ] || [ "$rc" = "143" ] || [ "$rc" = "130" ]
}

say "校验节点配置 ..."
if ! preflight "$INSTALL_DIR/config.toml"; then
  echo "---------- 预检输出 ----------" >&2
  tail -n 25 "$STATE_DIR/preflight.log" >&2 || true
  echo "-----------------------------" >&2
  die "节点配置校验未通过，核心程序拒绝启动。请把上面的输出反馈给管理员。"
fi
ok "配置校验通过"

# --------------------------- systemd 主服务 ---------------------------
cat > "/etc/systemd/system/${SERVICE}.service" <<XW_UNIT_EOF
[Unit]
Description=XiangWang Mesh Node (EasyTier core)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${CORE_BIN} -c ${INSTALL_DIR}/config.toml
Restart=always
RestartSec=5
LimitNOFILE=65535
WorkingDirectory=${INSTALL_DIR}

[Install]
WantedBy=multi-user.target
XW_UNIT_EOF

# ------------------------------ 节点代理 ------------------------------
cat > "$INSTALL_DIR/agent.sh" <<XW_AGENT_EOF
#!/bin/sh
# 湘网组网节点代理：上报心跳与流量 + 同步配置
CONSOLE_URL="$CONSOLE_URL"
INSTALL_DIR="$INSTALL_DIR"
STATE_DIR="$STATE_DIR"
SERVICE="$SERVICE"
CORE_BIN="$CORE_BIN"
CFG="$INSTALL_DIR/config.toml"
RPC_PORT="$RPC_PORT"

[ -f "\$INSTALL_DIR/config.env" ] && . "\$INSTALL_DIR/config.env"
RPC_PORT="\${RPC_PORT:-$RPC_PORT}"

CORE_VERSION=""
[ -x "\$CORE_BIN" ] && CORE_VERSION="\$("\$CORE_BIN" --version 2>/dev/null | awk '{print \$2}')"

PEER_COUNT=0
if [ -x "\$INSTALL_DIR/bin/easytier-cli" ]; then
  RAW="\$("\$INSTALL_DIR/bin/easytier-cli" -p "127.0.0.1:\${RPC_PORT}" peer 2>/dev/null || true)"
  if [ -n "\$RAW" ]; then
    PEER_COUNT="\$(printf '%s\n' "\$RAW" | grep -c '^|' || true)"
    [ "\$PEER_COUNT" -gt 0 ] 2>/dev/null && PEER_COUNT=\$((PEER_COUNT - 1)) || PEER_COUNT=0
  fi
fi

RX=0
TX=0
if [ -r /proc/net/dev ]; then
  DEV_NAME="\$(sed -n 's/^ *dev_name *= *"\(.*\)"/\1/p' "\$CFG" 2>/dev/null | head -n1)"
  [ -n "\$DEV_NAME" ] || DEV_NAME=xwtun0
  STAT="\$(awk -v d="\$DEV_NAME:" '\$1==d {print \$2" "\$10}' /proc/net/dev 2>/dev/null || true)"
  [ -n "\$STAT" ] && RX="\$(echo "\$STAT" | awk '{print \$1}')" && TX="\$(echo "\$STAT" | awk '{print \$2}')"
fi

HOSTNAME_R="\$(hostname 2>/dev/null || echo unknown)"
PLATFORM="\$(uname -s -m 2>/dev/null || echo unknown)"
REPORTED_IP="\$(ip route get 1.1.1.1 2>/dev/null | awk '/src/ {for(i=1;i<=NF;i++) if(\$i=="src") print \$(i+1)}' | head -n1 || true)"

RESP="\$(curl -s -m 15 -X POST "\$CONSOLE_URL/api/agent/heartbeat" \\
  -H 'Content-Type: application/json' \\
  -d "{\\"token\\":\\"\$NODE_TOKEN\\",\\"hostname\\":\\"\$HOSTNAME_R\\",\\"coreVersion\\":\\"\$CORE_VERSION\\",\\"peerCount\\":\${PEER_COUNT:-0},\\"platform\\":\\"\$PLATFORM\\",\\"reportedIp\\":\\"\$REPORTED_IP\\",\\"rxBytes\\":\${RX:-0},\\"txBytes\\":\${TX:-0}}" \\
  2>/dev/null || true)"

case "\$RESP" in
  *'"revoked":true'*)
    systemctl stop "\$SERVICE" 2>/dev/null || true
    systemctl disable "\$SERVICE" 2>/dev/null || true
    systemctl disable --now "\${SERVICE%-node}-agent.timer" 2>/dev/null || true
    exit 0
    ;;
esac

TMP="\$STATE_DIR/config.new"
CODE="\$(curl -s -m 15 -o "\$TMP" -w '%{http_code}' "\$CONSOLE_URL/api/agent/config?token=\$NODE_TOKEN" 2>/dev/null || echo 000)"
if [ "\$CODE" = "403" ]; then
  systemctl stop "\$SERVICE" 2>/dev/null || true
  exit 0
fi
if [ "\$CODE" = "200" ] && [ -s "\$TMP" ] && ! cmp -s "\$TMP" "\$CFG"; then
  if grep -q 'network_identity' "\$TMP"; then
    systemctl stop "\$SERVICE" 2>/dev/null || true
    rc=0
    if command -v timeout >/dev/null 2>&1; then
      timeout 8 "\$CORE_BIN" -c "\$TMP" >"\$STATE_DIR/preflight.log" 2>&1 || rc=\$?
      case "\$rc" in 124|143|130) rc=0 ;; *) rc=1 ;; esac
    fi
    if [ "\$rc" = "0" ]; then
      cp "\$CFG" "\$STATE_DIR/config.bak"
      mv "\$TMP" "\$CFG"
      chmod 600 "\$CFG"
      systemctl start "\$SERVICE" 2>/dev/null || true
    else
      rm -f "\$TMP"
      systemctl start "\$SERVICE" 2>/dev/null || true
    fi
  fi
fi
rm -f "\$TMP"
XW_AGENT_EOF
chmod +x "$INSTALL_DIR/agent.sh"

cat > "$AGENT_UNIT" <<XW_AGENT_UNIT_EOF
[Unit]
Description=XiangWang Mesh Agent (heartbeat, traffic report, config sync)

[Service]
Type=oneshot
ExecStart=${INSTALL_DIR}/agent.sh
XW_AGENT_UNIT_EOF

cat > "$AGENT_TIMER" <<XW_TIMER_EOF
[Unit]
Description=XiangWang Mesh Agent Timer

[Timer]
OnBootSec=20s
OnUnitActiveSec=30s
AccuracySec=5s

[Install]
WantedBy=timers.target
XW_TIMER_EOF

# ------------------------------ 启动服务 ------------------------------
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"
systemctl enable --now "${AGENT_SERVICE}.timer" >/dev/null 2>&1 || true

sleep 3

if systemctl is-active --quiet "$SERVICE"; then
  echo
  ok "接入成功，节点已上线"
  echo
  echo "  网络名称 : ${NETWORK_NAME_R:-（由控制台下发）}"
  echo "  节点名称 : ${NODE_NAME_R:-$HOSTNAME_R}"
  echo "  虚拟 IP  : ${VIRTUAL_IP_R:-（由控制台下发）}"
  echo "  核心版本 : $("$CORE_BIN" --version 2>/dev/null || echo 未知)"
  echo "  配置版本 : v$(grep -m1 'CONFIG_VERSION' "$INSTALL_DIR/config.toml" | sed 's/.*CONFIG_VERSION=//' | tr -d '[:space:]')"
  echo
  echo "  查看邻居 : $INSTALL_DIR/bin/easytier-cli -p 127.0.0.1:$RPC_PORT peer"
  echo "  查看路由 : $INSTALL_DIR/bin/easytier-cli -p 127.0.0.1:$RPC_PORT route"
  echo "  查看日志 : journalctl -u $SERVICE -f"
  echo
  say "回到控制台刷新，即可看到本节点状态。"
else
  die "服务启动失败，请查看：journalctl -u $SERVICE -n 50 --no-pager"
fi
