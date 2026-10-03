#!/bin/sh
# 湘网组网 — 节点一键接入脚本 (Linux / systemd)
#
# 用法：
#   NET_NAME=xiangwang NET_SECRET=yoursecret VPS_IP=10.144.144.2 \
#     sh join-node.sh
#
# 可选环境变量：
#   PEERS      要连接的节点/公共节点，默认官方公共节点
#   NODE_NAME  节点显示名，默认取主机名
#   ET_VERSION 使用的 EasyTier 版本，默认 2.6.4
#   RPC_PORT   本地 RPC 端口，默认 15888（仅监听回环）
#
# 注意：本脚本只下载并运行 EasyTier 官方二进制，不修改其源码。
#       EasyTier 以 LGPL-3.0 发布，许可证全文随二进制一并保留。

set -eu

NET_NAME="${NET_NAME:-}"
NET_SECRET="${NET_SECRET:-}"
VPS_IP="${VPS_IP:-}"
PEERS="${PEERS:-tcp://public.easytier.cn:11010}"
NODE_NAME="${NODE_NAME:-$(hostname 2>/dev/null || echo node)}"
ET_VERSION="${ET_VERSION:-2.6.4}"
RPC_PORT="${RPC_PORT:-15888}"
INSTALL_DIR="${INSTALL_DIR:-/opt/xiangwang}"
SERVICE_NAME="xiangwang-node"

say() { printf '\033[32m[湘网组网]\033[0m %s\n' "$1"; }
die() { printf '\033[31m[错误]\033[0m %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "请用 root 运行（sudo sh join-node.sh）"
[ -n "$NET_NAME" ] || die "缺少 NET_NAME（网络名）"
[ -n "$NET_SECRET" ] || die "缺少 NET_SECRET（网络密钥）"
command -v systemctl >/dev/null 2>&1 || die "未检测到 systemd。OpenWrt/NAS 请改用对应平台的接入方式。"

case "$(uname -m)" in
  x86_64|amd64)   ARCH=x86_64 ;;
  aarch64|arm64)  ARCH=aarch64 ;;
  armv7l)         ARCH=armv7 ;;
  armv7)          ARCH=armv7hf ;;
  armhf)          ARCH=armhf ;;
  mips)           ARCH=mips ;;
  mipsel)         ARCH=mipsel ;;
  arm*)           ARCH=arm ;;
  *)              die "未识别的架构：$(uname -m)" ;;
esac

command -v unzip >/dev/null 2>&1 || {
  say "安装 unzip ..."
  (apt-get update -qq && apt-get install -y -qq unzip) || \
  (yum install -y -q unzip) || die "请手动安装 unzip 后重试"
}

mkdir -p "$INSTALL_DIR/bin"
cd "$INSTALL_DIR"

BASE_URL="https://github.com/EasyTier/EasyTier/releases/download/v${ET_VERSION}"
PKG="easytier-linux-${ARCH}-v${ET_VERSION}.zip"

say "架构：$ARCH   版本：$ET_VERSION"

if [ ! -f "$INSTALL_DIR/bin/easytier-core" ]; then
  say "下载 EasyTier 核心程序 ..."
  if ! curl -fL --connect-timeout 15 -o "$PKG" "$BASE_URL/$PKG"; then
    say "直连失败，尝试加速镜像 ..."
    curl -fL --connect-timeout 15 -o "$PKG" "https://ghfast.top/$BASE_URL/$PKG" \
      || die "下载失败，请手动下载 $PKG 放到 $INSTALL_DIR 后重试"
  fi
  unzip -o -q "$PKG" -d "$INSTALL_DIR/bin"
  chmod +x "$INSTALL_DIR/bin/"easytier-*
fi

# 兼容压缩包内可能存在的子目录
if [ ! -f "$INSTALL_DIR/bin/easytier-core" ]; then
  CORE_PATH="$(find "$INSTALL_DIR/bin" -type f -name easytier-core | head -n 1)"
  [ -n "$CORE_PATH" ] || die "压缩包中未找到 easytier-core"
  cp "$(dirname "$CORE_PATH")"/easytier-* "$INSTALL_DIR/bin/"
  chmod +x "$INSTALL_DIR/bin/"easytier-*
fi

say "核心版本：$("$INSTALL_DIR/bin/easytier-core" --version 2>/dev/null || echo '未知')"

cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=XiangWang Mesh Node (EasyTier core)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=RUST_LOG=info
ExecStart=${INSTALL_DIR}/bin/easytier-core \\
  --network-name ${NET_NAME} \\
  --network-secret ${NET_SECRET} \\
  --peers ${PEERS} \\
  --hostname ${NODE_NAME} \\
  --rpc-portal 127.0.0.1:${RPC_PORT}${VPS_IP:+ \\
  --ipv4 ${VPS_IP}}
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ${SERVICE_NAME} >/dev/null 2>&1 || true
systemctl restart ${SERVICE_NAME}

sleep 3
if systemctl is-active --quiet ${SERVICE_NAME}; then
  say "接入成功。"
  echo
  echo "  网络名称 : ${NET_NAME}"
  echo "  节点名称 : ${NODE_NAME}"
  echo "  虚拟 IP  : ${VPS_IP:-（未指定）}"
  echo "  RPC 端口 : 127.0.0.1:${RPC_PORT}"
  echo
  echo "  查看邻居节点： ${INSTALL_DIR}/bin/easytier-cli -p 127.0.0.1:${RPC_PORT} peer"
  echo "  查看路由表：   ${INSTALL_DIR}/bin/easytier-cli -p 127.0.0.1:${RPC_PORT} route"
  echo "  查看运行日志： journalctl -u ${SERVICE_NAME} -f"
  echo
  echo "  提示：参数名如有变动，请以 easytier-core --help 为准。"
else
  die "服务启动失败，请查看：journalctl -u ${SERVICE_NAME} -n 50"
fi
