#!/bin/sh
# =====================================================================
#  湘网组网 · 节点接入脚本
#  由控制台自动生成，节点身份与配置已内置，直接执行即可
#  使用：sudo sh xiangwang-node.sh
# =====================================================================
set -eu

CONSOLE_URL="{{CONSOLE_URL}}"
NODE_TOKEN="{{NODE_TOKEN}}"
ET_VERSION="{{ET_VERSION}}"
INSTALL_DIR="/opt/xiangwang"
SERVICE="xiangwang-node"
AGENT_SERVICE="xiangwang-agent"

say() { printf '\033[32m[湘网组网]\033[0m %s\n' "$1"; }
die() { printf '\033[31m[错误]\033[0m %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "请用 root 权限运行（sudo sh $0）"
command -v systemctl >/dev/null 2>&1 || die "当前环境没有 systemd，暂不支持自动接入"

case "$(uname -m)" in
  x86_64|amd64)  ARCH=x86_64 ;;
  aarch64|arm64) ARCH=aarch64 ;;
  armv7l)        ARCH=armv7 ;;
  armv7)         ARCH=armv7hf ;;
  armhf)         ARCH=armhf ;;
  mips)          ARCH=mips ;;
  mipsel)        ARCH=mipsel ;;
  arm*)          ARCH=arm ;;
  *)             die "未识别的架构：$(uname -m)" ;;
esac

command -v curl >/dev/null 2>&1 || {
  say "安装 curl ..."
  (apt-get update -qq && apt-get install -y -qq curl) || (yum install -y -q curl) || die "请先手动安装 curl"
}
command -v unzip >/dev/null 2>&1 || {
  say "安装 unzip ..."
  (apt-get update -qq && apt-get install -y -qq unzip) || (yum install -y -q unzip) || die "请先手动安装 unzip"
}

mkdir -p "$INSTALL_DIR/bin" "$INSTALL_DIR/state"

if [ ! -x "$INSTALL_DIR/bin/easytier-core" ]; then
  cd "$INSTALL_DIR"
  PKG="easytier-linux-${ARCH}-v${ET_VERSION}.zip"
  URL="https://github.com/EasyTier/EasyTier/releases/download/v${ET_VERSION}/${PKG}"
  say "下载核心程序（$ARCH / v$ET_VERSION）..."
  curl -fL --connect-timeout 20 -o "$PKG" "$URL" 2>/dev/null \
    || curl -fL --connect-timeout 20 -o "$PKG" "https://ghfast.top/${URL}" 2>/dev/null \
    || die "下载失败，请手动下载 $PKG 并放到 $INSTALL_DIR 后重试"
  unzip -o -q "$PKG" -d "$INSTALL_DIR/bin"
  CORE="$(find "$INSTALL_DIR/bin" -type f -name easytier-core | head -n1)"
  [ -n "$CORE" ] || die "压缩包内未找到 easytier-core"
  cp "$(dirname "$CORE")"/easytier-* "$INSTALL_DIR/bin/"
  chmod +x "$INSTALL_DIR/bin/"easytier-*
  rm -f "$PKG"
fi

cat > "$INSTALL_DIR/config.env" <<'XW_ENV_EOF'
{{CONFIG_ENV}}
XW_ENV_EOF
chmod 600 "$INSTALL_DIR/config.env"

cat > "/etc/systemd/system/${SERVICE}.service" <<XW_UNIT_EOF
[Unit]
Description=XiangWang Mesh Node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${INSTALL_DIR}/config.env
ExecStart=/bin/sh -c 'exec ${INSTALL_DIR}/bin/easytier-core --network-name "\$NETWORK_NAME" --network-secret "\$NETWORK_SECRET" --peers "\$PEERS" --hostname "\$NODE_NAME" --ipv4 "\$VIRTUAL_IP" --rpc-portal "127.0.0.1:\$RPC_PORT"'
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
XW_UNIT_EOF

cat > "$INSTALL_DIR/agent.sh" <<XW_AGENT_EOF
#!/bin/sh
# 湘网组网节点代理：上报心跳 + 同步配置
INSTALL_DIR="$INSTALL_DIR"
CONSOLE_URL="$CONSOLE_URL"
NODE_TOKEN="$NODE_TOKEN"

[ -f "\$INSTALL_DIR/config.env" ] && . "\$INSTALL_DIR/config.env"

RPC_PORT="\${RPC_PORT:-15888}"
CORE_VERSION=""
if [ -x "\$INSTALL_DIR/bin/easytier-core" ]; then
  CORE_VERSION="\$("\$INSTALL_DIR/bin/easytier-core" --version 2>/dev/null | awk '{print \$2}')"
fi

PEER_COUNT=0
if [ -x "\$INSTALL_DIR/bin/easytier-cli" ]; then
  RAW="\$("\$INSTALL_DIR/bin/easytier-cli" -p "127.0.0.1:\${RPC_PORT}" peer 2>/dev/null || echo '')"
  if [ -n "\$RAW" ]; then
    PEER_COUNT="\$(printf '%s\n' "\$RAW" | wc -l)"
    PEER_COUNT=\$((PEER_COUNT - 1))
    [ "\$PEER_COUNT" -lt 0 ] && PEER_COUNT=0
  fi
fi

HOSTNAME_R="\$(hostname 2>/dev/null || echo unknown)"
PLATFORM="\$(uname -s -m 2>/dev/null || echo unknown)"
REPORTED_IP="\$(ip route get 1.1.1.1 2>/dev/null | awk '/src/ {for(i=1;i<=NF;i++) if(\$i=="src") print \$(i+1)}' | head -n1)"

curl -s -m 10 -X POST "\$CONSOLE_URL/api/agent/heartbeat" \\
  -H 'Content-Type: application/json' \\
  -d "{\\"token\\":\\"\$NODE_TOKEN\\",\\"hostname\\":\\"\$HOSTNAME_R\\",\\"coreVersion\\":\\"\$CORE_VERSION\\",\\"peerCount\\":\$PEER_COUNT,\\"platform\\":\\"\$PLATFORM\\",\\"reportedIp\\":\\"\$REPORTED_IP\\"}" \\
  >/dev/null 2>&1 || true

NEW_CONFIG="\$(curl -s -m 10 "\$CONSOLE_URL/api/agent/config?token=\$NODE_TOKEN" 2>/dev/null || echo '')"
if [ -n "\$NEW_CONFIG" ]; then
  printf '%s\n' "\$NEW_CONFIG" > "\$INSTALL_DIR/state/config.new"
  if ! cmp -s "\$INSTALL_DIR/state/config.new" "\$INSTALL_DIR/config.env"; then
    cp "\$INSTALL_DIR/state/config.new" "\$INSTALL_DIR/config.env"
    chmod 600 "\$INSTALL_DIR/config.env"
    systemctl restart ${SERVICE}
  fi
  rm -f "\$INSTALL_DIR/state/config.new"
fi
XW_AGENT_EOF
chmod +x "$INSTALL_DIR/agent.sh"

cat > "/etc/systemd/system/${AGENT_SERVICE}.service" <<XW_AGENT_UNIT_EOF
[Unit]
Description=XiangWang Mesh Agent (heartbeat and config sync)

[Service]
Type=oneshot
ExecStart=${INSTALL_DIR}/agent.sh
XW_AGENT_UNIT_EOF

cat > "/etc/systemd/system/${AGENT_SERVICE}.timer" <<XW_TIMER_EOF
[Unit]
Description=XiangWang Mesh Agent Timer

[Timer]
OnBootSec=20s
OnUnitActiveSec=30s
AccuracySec=5s

[Install]
WantedBy=timers.target
XW_TIMER_EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"
systemctl enable --now "${AGENT_SERVICE}.timer" >/dev/null 2>&1 || true

sleep 3

if systemctl is-active --quiet "$SERVICE"; then
  say "接入成功，节点已上线。"
  echo
  echo "  网络名称 : {{NETWORK_NAME}}"
  echo "  节点名称 : {{NODE_NAME}}"
  echo "  虚拟 IP  : {{VIRTUAL_IP}}"
  echo "  核心版本 : $("$INSTALL_DIR/bin/easytier-core" --version 2>/dev/null || echo '未知')"
  echo
  echo "  查看邻居 : $INSTALL_DIR/bin/easytier-cli -p 127.0.0.1:${RPC_PORT:-15888} peer"
  echo "  查看日志 : journalctl -u $SERVICE -f"
  echo
  say "回控制台刷新，即可看到本节点状态。"
else
  die "服务启动失败，请查看：journalctl -u $SERVICE -n 50 --no-pager"
fi
