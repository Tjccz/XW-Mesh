# 用 Dockge 部署湘网组网控制台

> 适用宿主机：**飞牛 NAS** / iStoreOS 软路由 / 群晖 / 宝塔面板等任何已装 Docker + Dockge 的环境

---

## ⚠️ 先看这条：镜像不在任何仓库里

**本项目没有把镜像发布到 Docker Hub 或任何 registry，所以 `docker pull` 一定失败。**

你必须用源码在本地构建一次。好在控制台镜像很小、构建很快：

```sh
docker build -f deploy/dockge/Dockerfile.slim -t xiangwang-mesh-console:1.1.0 .
```

构建完镜像就在本机了，之后 Dockge 只负责「跑这个镜像」，不再需要构建。

---

## 一、把代码放到宿主机上

### 方式 A：用发行包（推荐）

发行包 `xiangwang-mesh-dockge-1.1.0.tar.gz` **已内置构建好的 `web/dist`**，
宿主机上不需要装 Node、不需要跑 Vite，也不需要联网拉前端依赖。

```sh
# 在宿主机上解压（路径按你的习惯改）
mkdir -p /vol1/1000/docker/xw-mesh
tar -xzf xiangwang-mesh-dockge-1.1.0.tar.gz -C /vol1/1000/docker/xw-mesh
cd /vol1/1000/docker/xw-mesh
```

怎么把包传上去，看你方便：

| 方式 | 做法 |
| --- | --- |
| SSH / SCP | `scp xiangwang-mesh-dockge-1.1.0.tar.gz 用户名@NAS地址:/tmp/` |
| SMB / 文件共享 | 直接拖进 NAS 的共享目录，再 SSH 解压 |
| Dockge 文件管理 | 传进 Stack 目录后用 Dockge 内置终端解压 |

### 方式 B：从仓库拉（仓库是私有的，需要凭据）

```sh
git clone git@github.com:Tjccz/XW-Mesh.git xw-mesh && cd xw-mesh
# 仓库里没有 web/dist（被 .gitignore 排除），需本地构建一次
cd web && npm ci && npm run build && cd ..
```

---

## 二、构建镜像

```sh
cd /vol1/1000/docker/xw-mesh

# 控制台（预构建前端，只装 express + cors，几十秒完成）
docker build -f deploy/dockge/Dockerfile.slim -t xiangwang-mesh-console:1.1.0 .
```

> **关于两个 Dockerfile 的选择**
>
> | 文件 | 特点 |
> | --- | --- |
> | `deploy/dockge/Dockerfile.slim`（推荐） | 复用预构建 `web/dist`，镜像内只装两个纯 JS 包，构建快、几乎不吃内存 |
> | 根目录 `Dockerfile` | 会在镜像内跑 `npm ci` + `vite build`，要拉约 200MB 前端依赖、峰值内存数百 MB。x86 NAS 跑得动，但没必要 |
>
> 因为**镜像内跑 vite build 有 OOM 风险**，软路由那种小机器只能用 slim 版；
> NAS 上两个都能用，但 slim 依然更快。

以后要做「本机也加入组网」，再构建节点镜像：

```sh
docker build -f docker/Dockerfile.node -t xiangwang-mesh-node:1.1.0 .
```

> **拉不到基础镜像（`node:22-alpine` / `debian:12-slim`）？**
> 大陆网络访问 Docker Hub 经常超时。在 Docker 配置里加一个镜像加速地址再重试。

---

## 三、在 Dockge 里建 Stack

1. 打开 Dockge → **+ 新建 Stack**，名字填 `xiangwang-mesh`
2. 把 `deploy/dockge/compose.yaml` 的内容**整份粘进去**
3. 切到 **.env** 标签，把 `deploy/dockge/.env.example` 的内容粘进去，
   **务必改掉 `ADMIN_PASSWORD`**
4. 点 **部署**

容器起来后访问 `http://宿主机IP:8080`。

> **`CONSOLE_URL` 建议留空。**
> 留空时程序会自动回退成「浏览器当前访问的地址」，所以换机器、换 IP、换端口都不用改配置，
> 也就不会出现「设备接入脚本回连到旧地址」这种问题。
> 只有走域名或反向代理时才需要显式填写。

---

## 四、让这台机器自己也加入组网（第二步）

1. 登录控制台 → **网络管理** → 新建网络
   - 如果这台机器上本来就跑着别的 EasyTier，网段**避开它已占用的网段**
     （例如宿主机原生 EasyTier 常用 `10.144.144.0/24`），换个干净的如 `10.200.200.0/24`
2. **设备接入密钥** → 新建密钥 → 复制 `ek_` 开头的值
3. 回到 Dockge，把 compose 内容**换成 `deploy/dockge/compose.full.yaml`**，
   在 .env 里填上 `ACCESS_KEY=ek_xxxxxxxx`
4. 重新部署

几十秒后留意：

- 控制台 **设备管理** 中会出现这台机器，状态「在线」
- 它拿到的虚拟 IP 在你新建的网段内

> 容器要创建 TUN 网卡。若启动报错，先确认宿主机有 `/dev/net/tun`
> （x86 NAS 一般都有；OpenWrt 软路由可能要先 `opkg install kmod-tun`）。

---

## 五、常见问题

| 现象 | 原因与处理 |
| --- | --- |
| `docker pull` 报 `not found` | 正常现象。镜像没发布到 registry，必须按上文本地构建 |
| 容器起不来，提示 `ADMIN_PASSWORD` 未设置 | 这是故意的。`.env` 里必须填密码，避免弱口令上线 |
| 8080 被占用 | 改 `.env` 里的 `HOST_PORT`（如 18080）后重新部署 |
| `docker build` 拉基础镜像超时 | Docker Hub 在大陆不稳定，配镜像加速地址 |
| 节点容器反复重启，日志报 TUN 错误 | 宿主机缺 `/dev/net/tun`，装 `kmod-tun` 后重启 |
| 控制台能开但节点回连失败 | 检查 `CONSOLE_URL` 是否被显式设成了**设备访问不到**的地址；不确定就留空 |
| 忘记管理员密码 | 优先在库内改密；删 `data/` 重建会**丢数据** |

---

## 六、运维命令

```sh
cd /vol1/1000/docker/xw-mesh        # 或你放 compose 的目录
docker logs -f xiangwang-console     # 看日志
docker compose restart console       # 重启控制台
docker compose down                  # 停止（data/ 保留）
```

备份只需要拷走 `data/` 目录 —— 数据库、配置快照全在里面。
