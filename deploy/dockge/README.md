# 用 Dockge 部署湘网组网控制台

> 适用宿主机：**飞牛 NAS** / iStoreOS 软路由 / 群晖 / 宝塔面板等任何已装 Docker + Dockge 的环境

---

## ⚠️ 先看这两条，否则一定卡住

**① 镜像不在任何 registry —— `docker pull` 必然失败。**

本项目从未把镜像推送到 Docker Hub 或任何 registry。正确顺序是：
**拉源码 → 本地 `docker build` → Dockge 跑这个本地镜像**。

**② 不要试图改 `.dockerignore` 来排除 `web/dist`。**

`deploy/dockge/Dockerfile.slim` 靠 `COPY web/dist` 复用仓库里**已预构建好的前端**，
正因如此 NAS 上**不需要安装 Node、不需要跑 Vite**。
一旦 `web/dist` 被排除出构建上下文，构建会在 COPY 那一步直接失败。

---

## 一、拉代码

仓库是**公开**的，直接克隆即可：

```sh
cd /vol1/1000/docker          # 换成你的存放位置
git clone https://github.com/Tjccz/XW-Mesh.git xw-mesh
cd xw-mesh
```

> `web/dist` **已在仓库里**（约 1.8 MB），所以克隆完就能直接构建，不需要 Node。
>
> 没有 git 或不想装 git？也可以用发行包
> `xiangwang-mesh-dockge-1.1.0.tar.gz`，解压即同上：
> ```sh
> mkdir -p /vol1/1000/docker/xw-mesh
> tar -xzf xiangwang-mesh-dockge-1.1.0.tar.gz -C /vol1/1000/docker/xw-mesh
> cd /vol1/1000/docker/xw-mesh
> ```

---

## 二、构建镜像

```sh
docker build -f deploy/dockge/Dockerfile.slim -t xiangwang-mesh-console:1.1.0 .
```

几十秒即可完成（镜像内只装 `express` + `cors` 两个纯 JS 包）。

> **关于两个 Dockerfile 的选择**
>
> | 文件 | 特点 |
> | --- | --- |
> | `deploy/dockge/Dockerfile.slim`（推荐） | 复用仓库里的 `web/dist`，构建快、几乎不吃内存 |
> | 根目录 `Dockerfile` | 会在镜像内跑 `npm ci` + `vite build`，需拉约 200MB 前端依赖、峰值内存数百 MB。x86 NAS 跑得动，但没必要 |
>
> 因为**镜像内跑 vite build 有 OOM 风险**，软路由那种小内存机器只能用 slim 版。

以后要做「这台机器自己也加入组网」，再构建节点镜像：

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

容器起来后访问 **`http://宿主机IP:6088`**。

> **端口说明**：宿主机端口默认 **6088**，刻意避开 NAS / 软路由上常被占用的 8080。
> 容器内始终监听 8080，**不需要也不要改右侧**。若 6088 也被占用，
> 改 `.env` 里的 `HOST_PORT` 即可。

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
| `docker build` 报 `web/dist ... not found in build context or excluded by .dockerignore` | `.dockerignore` 把 `web/dist` 排除了。删掉其中任何匹配 `dist` 的规则（详见本文件开篇第 ② 条） |
| 容器起不来，提示 `ADMIN_PASSWORD` 未设置 | 这是故意的。`.env` 里必须填密码，避免弱口令上线 |
| 6088 被占用 | 改 `.env` 里的 `HOST_PORT`（如 16088）后重新部署 |
| `docker build` 拉基础镜像超时 | Docker Hub 在大陆不稳定，配镜像加速地址 |
| 节点容器反复重启，日志报 TUN 错误 | 宿主机缺 `/dev/net/tun`，装 `kmod-tun` 后重启 |
| 控制台能开但节点回连失败 | 检查 `CONSOLE_URL` 是否被显式设成了**设备访问不到**的地址；不确定就留空 |
| 忘记管理员密码 | 优先在库内改密；删 `data/` 重建会**丢数据** |
| 界面是旧版本 | 前端改了但 `web/dist` 没重新构建提交。执行 `cd web && npm run build` 后重新 `docker build` |

---

## 六、运维命令

```sh
cd /vol1/1000/docker/xw-mesh        # 或你放代码的目录
docker logs -f xiangwang-console     # 看日志
docker compose restart console       # 重启控制台
docker compose down                  # 停止（data/ 保留）
```

备份只需要拷走 `data/` 目录 —— 数据库、配置快照全在里面。
