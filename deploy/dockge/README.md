# 在 iStoreOS 软路由上用 Dockge 部署湘网组网

> 目标环境：iStoreOS（OpenWrt 系）软路由，已装 Docker 与 Dockge
> 实测地址：`192.168.88.5`，Dockge 在 `:5001`，Nginx UI 在 `:80`

---

## 为什么这里不受 opkg 限制

节点接入脚本 `server/src/templates/node-install.sh` 只支持 `apt-get / yum / apk`，
**没有 opkg** —— 所以**不能**在 OpenWrt 宿主机上直接跑它。

但容器里是独立的 Debian/Alpine 用户空间，和宿主机的包管理器无关。
**以容器方式接入，就完全绕开了这个限制。** 这也是本方案推荐容器部署的主要原因。

---

## 一、把代码放到路由器上

两种方式任选。**方式 A 更省事**。

### 方式 A：用发行包（推荐）

发行包 `xiangwang-mesh-dockge-1.1.0.tar.gz` 已内置构建好的 `web/dist`，
路由器上不需要装 Node、不需要跑 Vite。

```sh
# 在路由器上（SSH 端口按你的实际情况，你给的是 44322）
mkdir -p /root/xw-mesh
tar -xzf xiangwang-mesh-dockge-1.1.0.tar.gz -C /root/xw-mesh
cd /root/xw-mesh
```

把包传上去（在**你的电脑**上执行）：

```sh
scp -P 44322 xiangwang-mesh-dockge-1.1.0.tar.gz root@192.168.88.5:/root/
```

### 方式 B：从仓库拉（仓库是私有的，需要凭据）

```sh
cd /root && git clone git@github.com:Tjccz/XW-Mesh.git xw-mesh && cd xw-mesh
# 仓库里没有 web/dist（被 .gitignore 排除），需要本地构建一次
cd web && npm ci && npm run build && cd ..
```

---

## 二、构建镜像

```sh
cd /root/xw-mesh

# 控制台（预构建前端，只装 express + cors，几十秒完成）
docker build -f deploy/dockge/Dockerfile.slim -t xiangwang-mesh-console:1.1.0 .
```

如果以后要做「本机也加入组网」，再构建节点镜像：

```sh
docker build -f docker/Dockerfile.node -t xiangwang-mesh-node:1.1.0 .
```

> **拉不到基础镜像？** 大陆网络访问 Docker Hub 经常超时。
> 在 iStoreOS 的「Docker → 配置」里加一个镜像加速地址再重试即可。

---

## 三、在 Dockge 里建 Stack

1. 打开 Dockge（`http://192.168.88.5:5001`）→ **+ 新建 Stack**
2. 名字填 `xiangwang-mesh`
3. 把 `deploy/dockge/compose.yaml` 的内容**整份粘进去**
4. 切到 **.env** 标签，把 `deploy/dockge/.env.example` 的内容粘进去，
   **务必改掉 `ADMIN_PASSWORD`**（本次我已生成一个：`[REDACTED]`，建议你换掉）
5. 点 **部署**

容器起来后访问 `http://192.168.88.5:8080` 即可。

> Dockge 的 Stack 目录默认在 `/opt/stacks/`。
> 如果想让 Dockge 直接管源码，可以把 `compose.yaml` 换成带 `build:` 的版本，
> 但那种方式要求整个源码树都在 Stack 目录里，不如「先 CLI 构建镜像 + Dockge 只跑容器」清爽。

---

## 四、让这台软路由自己也加入组网（第二步）

1. 登录控制台 → **网络管理** → 新建网络
   - 网段**建议避开 `10.144.144.0/24`**：这台路由器上原生的 EasyTier 已占用该网段，
     虽然容器网络命名空间独立不会直接冲突，但换一个网段（如 `10.200.200.0/24`）更干净
2. **设备接入密钥** → 新建密钥 → 复制 `ek_` 开头的值
3. 回到 Dockge，把 compose 内容**换成 `deploy/dockge/compose.full.yaml`**，
   在 .env 里填上 `ACCESS_KEY=ek_xxxxxxxx`
4. 重新部署

几十秒后留意：

- 控制台 **设备管理** 中会出现这台软路由，状态「在线」
- 它拿到的虚拟 IP 在你新建的网段内

> 容器要创建 TUN 网卡。若启动报错，先确认路由器有 `/dev/net/tun`，
> 没有的话在路由器上执行 `opkg install kmod-tun && reboot`。

---

## 五、常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 容器起不来，提示 `ADMIN_PASSWORD` 未设置 | 这是故意的。`.env` 里必须填上密码，避免弱口令上线 |
| 8080 被占用 | 改 `.env` 里的 `HOST_PORT`（如 18080）后重新部署 |
| `docker build` 拉基础镜像超时 | Docker Hub 在大陆不稳定，配镜像加速地址 |
| 节点容器反复重启，日志报 TUN 相关错误 | 装 `kmod-tun` 后重启路由器 |
| 控制台能开但节点回连失败 | 检查 `.env` 的 `CONSOLE_URL` 是否是**其他设备能访问到**的地址 |
| 忘记管理员密码 | `docker compose down` 后删掉 `data/` 重新部署会重建；**但那会丢数据**，优先用库内改密 |

---

## 六、部署后的运维命令

```sh
cd /opt/stacks/xiangwang-mesh      # 或你放 compose 的目录
docker logs -f xiangwang-console   # 看日志
docker compose restart console     # 重启控制台
docker compose down                # 停止（data/ 保留）
```

备份只需要拷走 `data/` 目录 —— 数据库、配置快照全在里面。
