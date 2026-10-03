# 用 Dockge 部署湘网组网控制台

> 适用宿主机：**飞牛 NAS** / iStoreOS 软路由 / 群晖 / 宝塔面板等任何已装 Docker + Dockge 的环境

---

## 一句话

**镜像已经发布在 GitHub 上，宿主机不需要做任何构建。**
Dockge 里填个镜像名，点部署就完事了。

```sh
docker pull ghcr.io/tjccz/xw-mesh-console:1.1.0
```

已实测：**无需登录即可匿名拉取**。可用标签 `1.1.0` / `latest` / `sha-<短哈希>`，
amd64 压缩后约 62.9 MB。

---

## 一、确认镜像可拉取

正常情况下不用做任何事，直接 `docker pull` 就行。想先确认一下：

```sh
docker pull ghcr.io/tjccz/xw-mesh-console:1.1.0
docker pull ghcr.io/tjccz/xw-mesh-node:1.1.0
```

> **只有在报 `401 Unauthorized` / `denied` 时才需要处理** ——
> 那说明包的可见性被设成了 Private。去
> `https://github.com/users/Tjccz/packages/container/xw-mesh-console/settings`
> 底部 **Danger Zone** → **Change visibility** → **Public**。
> 节点镜像同理。也可以用命令行：
> ```sh
> gh api -X PATCH /user/packages/container/xw-mesh-console -f visibility=public
> gh api -X PATCH /user/packages/container/xw-mesh-node    -f visibility=public
> ```
>
> 若报 `not found`（不是 401），则是镜像还没发布成功，
> 去 `https://github.com/Tjccz/XW-Mesh/actions` 看构建状态；
> 没跑过就点 **Run workflow** 手动触发，等 2~4 分钟。

---

## 二、在 Dockge 里建 Stack

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

## 三、让这台机器自己也加入组网（第二步）

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

## 四、升级

改了代码并推到 `main` 之后，Actions 会自动重新构建并推送。
宿主机上只需重新拉取：

```sh
docker compose pull && docker compose up -d
```

在 Dockge 里则是对着 Stack 点 **Pull** 再 **Update**。

> `data/` 目录（数据库）不会被碰，升级不会丢数据。
>
> 想**始终跟随最新**而不是固定版本，把 `.env` 里的
> `CONSOLE_IMAGE` 标签由 `1.1.0` 换成 `latest`。

---

## 五、可选：不用 registry 的两条退路

### A. 自己本地构建

镜像就是个普通的 Node 应用，构建很快（只装 `express` + `cors` 两个纯 JS 包）：

```sh
git clone https://github.com/Tjccz/XW-Mesh.git xw-mesh
cd xw-mesh
docker build -f deploy/dockge/Dockerfile.slim -t xiangwang-mesh-console:1.1.0 .
```

然后把 `.env` 里改成 `CONSOLE_IMAGE=xiangwang-mesh-console:1.1.0`。

> 仓库里**已经带着 `web/dist`**，所以这一步不需要装 Node、不需要跑 Vite。
>
> 路径可以不用 `git clone`，发行包 `xiangwang-mesh-dockge-1.1.0.tar.gz`
> 解压后内容一样（且 `.env` 已预填好）。

### B. 用发行包（不装 git 也行）

`xiangwang-mesh-dockge-1.1.0.tar.gz` 里内容与仓库一致，且 `.env` 已预填好：

```sh
mkdir -p /vol1/1000/docker/xw-mesh
tar -xzf xiangwang-mesh-dockge-1.1.0.tar.gz -C /vol1/1000/docker/xw-mesh
cd /vol1/1000/docker/xw-mesh
docker build -f deploy/dockge/Dockerfile.slim -t xiangwang-mesh-console:1.1.0 .
```

---

## 六、常见问题

| 现象 | 原因与处理 |
| --- | --- |
| `docker pull` 报 `401 Unauthorized` / `denied` | 包的可见性还是 Private，按第一节改成 Public |
| `docker pull` 报 `not found` | 包还没发布成功，去 Actions 页面看构建是否失败 |
| 拉取超时 / `i/o timeout` | `ghcr.io` 在大陆网络不稳，见下方说明 |
| `docker build` 报 `web/dist ... excluded by .dockerignore` | `.dockerignore` 被改坏了：不能有任何匹配 `dist` 的规则。跑 `python scripts/check-dockerignore.py .` 自检 |
| 容器起不来，提示 `ADMIN_PASSWORD` 未设置 | 这是故意的。`.env` 里必须填密码，避免弱口令上线 |
| 6088 被占用 | 改 `.env` 里的 `HOST_PORT`（如 16088）后重新部署 |
| 节点容器反复重启，日志报 TUN 错误 | 宿主机缺 `/dev/net/tun`，装 `kmod-tun` 后重启 |
| 控制台能开但节点回连失败 | 检查 `CONSOLE_URL` 是否被显式设成了**设备访问不到**的地址；不确定就留空 |
| 忘记管理员密码 | 优先在库内改密；删 `data/` 重建会**丢数据** |
| 界面是旧版本 | Actions 里前端是从源码重建的；若你本地改了前端，记得重新 `npm run build` 并提交 `web/dist` |

> **拉不动 `ghcr.io` 怎么办？**
> 两个办法：① 在 Docker 配置里给 `ghcr.io` 配加速地址；
> ② 走第五节的退路 A，本地构建。
> 还不行的话告诉我，我给 Actions 加上「把镜像导出成 tar.gz 挂到 Release」的方案，
> 你下载后 `docker load` 即可。

---

## 七、运维命令

```sh
cd /vol1/1000/docker/xw-mesh        # 或你放 compose 的目录
docker logs -f xiangwang-console     # 看日志
docker compose restart console       # 重启控制台
docker compose down                  # 停止（data/ 保留）
```

备份只需要拷走 `data/` 目录 —— 数据库、配置快照全在里面。
