# 宝塔面板 Docker 部署指南

湘网组网控制台（XW-Mesh Console）在**宝塔面板 + Docker** 环境下的完整部署说明。
按本文操作，你可以在自己的服务器上跑起一套**完全自建、不依赖任何第三方云**的异地组网控制台。

---

## 一、先搞清楚要部署什么

整套系统只有两类容器，**只有第 1 类是必须的**：

| 容器 | 镜像 | 作用 | 是否必须 |
| --- | --- | --- | --- |
| `xiangwang-console` | `xiangwang-mesh-console` | 控制台：Web 界面 + REST API + SQLite 数据库 + 节点接入脚本分发 | ✅ 必须 |
| `xiangwang-node` | `xiangwang-mesh-node` | 组网节点：跑 EasyTier 核心，让**这台服务器自己**也进内网 | ⬜ 可选 |

**关键设计**：控制台是**纯控制面**，不碰数据面流量，也不需要有 TUN 设备。真正跑流量的是各设备上的 EasyTier 核心二进制 —— 由控制台下发的接入脚本自动下载安装。

```
                    ┌──────────────────────────────────────┐
   浏览器 ──HTTPS──▶ │ 宝塔 Nginx（反代 + 证书）              │
                    └───────────────┬──────────────────────┘
                                    │ 127.0.0.1:8080
                    ┌───────────────▼──────────────────────┐
                    │ xiangwang-console 容器                │
                    │  Web 控制台 / REST API / SQLite       │
                    │  /api/agent/*  ← 节点心跳与配置同步     │
                    └───────────────┬──────────────────────┘
                                    │ （出站，无需入站端口）
      ┌──────────────┬──────────────┼──────────────┬──────────────┐
      ▼              ▼              ▼              ▼              ▼
  办公室 NAS     软路由 iStoreOS   云主机         Windows PC     手机
   （各设备运行 easytier-core，彼此直连 P2P，流量不过控制台）
```

### 端口清单

| 端口 | 位置 | 协议 | 是否需要公网放行 | 说明 |
| --- | --- | --- | --- | --- |
| 8080 | console 容器 | TCP | 仅调试时需要 | 控制台 HTTP。走 Nginx 反代后建议只绑内网 |
| 443 / 80 | 宝塔 Nginx | TCP | ✅ 需要 | 域名 + HTTPS 访问入口 |
| 11010 | **各节点设备** | TCP + UDP | ✅ 需要 | EasyTier 监听端口，用于 P2P 打洞与中继 |
| 11011 | **各节点设备** | TCP | 可选 | WireGuard / WebSocket 协议入口 |
| 15888 | **各节点设备** | TCP | ❌ 不需要 | 核心 RPC，仅供本机 `easytier-cli` 查询 |

> ⚠️ 注意：11010 / 11011 是**节点设备**的端口，不是控制台服务器的。控制台服务器本身不需要开放任何 EasyTier 端口（除非你启用了可选的 `node` 容器）。

---

## 二、服务器要求

| 项目 | 最低 | 推荐 |
| --- | --- | --- |
| CPU | 1 核 | 2 核 |
| 内存 | 512 MB | 1 GB |
| 磁盘 | 2 GB | 10 GB |
| 系统 | 任意 Linux（CentOS 7+ / Ubuntu 20+ / Debian 11+ / AlmaRocky） | Ubuntu 22.04 / Debian 12 |
| 面板 | 宝塔 Linux 面板 8.x 及以上 | 最新版 |

**为什么内存要 512MB 起**：控制台自身占用约 80–120 MB，但**首次构建镜像**需要跑 `npm install` 和 `vite build`，峰值可能到 700 MB。如果内存紧张，请在宝塔「系统 → Swap」中加 1–2 GB swap，或改用「方式三：离线镜像包」。

---

## 三、方式一（推荐）：宝塔面板图形化部署

### 步骤 1 · 安装 Docker 管理器

宝塔面板 → 左侧 **软件商店** → 搜索 `Docker` → 安装 **「Docker 管理器」**。

安装完成后左侧会出现 **Docker** 菜单，里面有「容器 / 镜像 / 网络 / 存储卷 / **容器编排**」等子页。

> 如果提示 Docker 未安装，在 Docker 管理器首页点「安装 Docker」；国内服务器建议在管理器设置里配置镜像加速地址。

### 步骤 2 · 上传项目目录

宝塔面板 → **文件** → 进入 `/www/wwwroot/` → 新建目录 `xiangwang-mesh` → 进入该目录 → 点「上传」，把整个项目压缩包上传后**在线解压**。

或者用 SSH：

```bash
mkdir -p /www/wwwroot && cd /www/wwwroot
git clone <你的仓库地址> xiangwang-mesh
cd xiangwang-mesh
```

上传后目录结构应至少包含：

```
xiangwang-mesh/
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── docker/
│   ├── Dockerfile.node
│   └── agent-entrypoint.sh
├── server/
├── web/
└── scripts/
```

### 步骤 3 · 创建 `.env` 配置文件

宝塔 **文件** → 进入 `xiangwang-mesh` → **新建文件** `.env` → 双击编辑，填入：

```ini
# 控制台对外端口（宿主机）
HOST_PORT=8080

# 控制台对外访问地址 —— 用域名时改成 https://你的域名
# 暂时没有域名，先留空，用 http://服务器IP:8080 也能跑通
CONSOLE_URL=

# 初始管理员账号
ADMIN_USER=admin
ADMIN_PASSWORD=改成你自己的强密码

# 版本
XW_VERSION=1.1.0
ET_VERSION=2.6.4
TZ=Asia/Shanghai
```

保存。也可以直接复制模板再改：

```bash
cd /www/wwwroot/xiangwang-mesh
cp .env.example .env
vi .env
```

> 文件权限建议设为 `600`（宝塔文件管理器 → 右键 .env → 权限）。

### 步骤 4 · 用「容器编排」启动

宝塔 → **Docker** → **容器编排** → 点「**添加编排**」：

- **名称**：`xiangwang-mesh`
- **项目目录 / 路径**：`/www/wwwroot/xiangwang-mesh`
- **编排内容来源**：选择「**本地文件**」或「**从目录读取 docker-compose.yml**」

确认后点「**部署 / 启动**」。宝塔会执行 `docker compose up -d --build`，首次构建需 **2–5 分钟**（下载 node 镜像 + npm 依赖），页面会滚动输出构建日志。

> 如果宝塔版本里没有「本地文件」选项，就直接把 `docker-compose.yml` 的内容复制粘贴进编排内容框。

### 步骤 5 · 验证部署

在「容器」列表中应看到 **`xiangwang-console`** 状态为 **运行中 / 健康**。

浏览器打开 `http://你的服务器IP:8080`，出现登录页即成功。

命令行验证：

```bash
curl http://127.0.0.1:8080/api/health
# {"ok":true,"service":"xiangwang-mesh","version":"1.1.0","etVersion":"2.6.4",...}

docker logs xiangwang-console --tail 30
```

### 步骤 6 · 放行端口

宝塔 → **安全** → **防火墙** → 「放行端口」→ 添加 `8080`（协议 TCP）。

> 如果用的是云服务器（腾讯云 / 阿里云 / 华为云等），还需要在**云厂商控制台的安全组**里放行 8080，否则外网访问不通。

---

## 四、方式二：SSH 命令行一键部署

宝塔面板 → **终端**，或本地 SSH 连上服务器：

```bash
cd /www/wwwroot
git clone <你的仓库地址> xiangwang-mesh
cd xiangwang-mesh

# 一键脚本：自动检查环境、生成随机强密码、构建、启动、等待健康
sh scripts/deploy.sh
```

脚本会输出访问地址和随机生成的初始密码。自定义参数：

```bash
HOST_PORT=9090 sh scripts/deploy.sh
CONSOLE_URL=https://mesh.example.com sh scripts/deploy.sh
```

常用运维命令：

```bash
docker compose ps                      # 查看容器状态
docker logs -f xiangwang-console       # 实时日志
docker compose restart console         # 重启控制台
docker compose down                    # 停止并删除容器（./data 数据保留）
docker compose up -d --build           # 重新构建并启动
```

---

## 五、方式三：离线镜像包部署（内网 / 无外网服务器）

适用于服务器访问 GitHub / npm 受限，或目标机没有构建能力的情况。

**在任意一台有 Docker 的联网机器上：**

```bash
cd xiangwang-mesh
docker compose build
docker save xiangwang-mesh-console:1.1.0 | gzip > xiangwang-console-1.1.0.tar.gz
```

**把 `xiangwang-console-1.1.0.tar.gz` + `docker-compose.yml` + `.env` 上传到目标服务器**，然后：

```bash
# 方式 A：宝塔「Docker → 镜像 → 导入镜像」，选择 tar.gz 上传
# 方式 B：命令行
docker load < xiangwang-console-1.1.0.tar.gz
docker images | grep xiangwang

# 用镜像启动（不再执行 build）
mkdir -p /www/wwwroot/xiangwang-mesh/data
docker run -d --name xiangwang-console --restart unless-stopped \
  -p 8080:8080 \
  -v /www/wwwroot/xiangwang-mesh/data:/data \
  -e CONSOLE_URL=https://mesh.example.com \
  -e ADMIN_USER=admin -e ADMIN_PASSWORD='你的强密码' \
  -e TZ=Asia/Shanghai \
  xiangwang-mesh-console:1.1.0
```

> 使用离线方式时，`docker-compose.yml` 中的 `build:` 段仍会触发构建。若不想构建，把 `image:` 一行的版本号与 `docker load` 的镜像保持一致，并在宝塔编排界面选择「**不构建，使用本地镜像**」，或直接删掉 `build:` 两行。

---

## 六、绑定域名 + HTTPS（强烈建议）

**为什么要做**：控制台下发的节点接入脚本里带着**节点令牌**。走 HTTP 明文传输，令牌等同裸奔；同时 `CONSOLE_URL` 用 HTTPS 才能保证异地设备回连不被劫持。

### 步骤 1 · 建站并反向代理

宝塔 → **网站** → **添加站点**：

- 域名：`mesh.example.com`
- 根目录：随意（如 `/www/wwwroot/mesh-proxy`，不会用到）
- 数据库 / PHP：**全部不创建**

站点创建后 → 点站点名 → **反向代理** → **添加反向代理**：

| 配置项 | 值 |
| --- | --- |
| 代理名称 | `xiangwang-console` |
| 目标 URL | `http://127.0.0.1:8080` |
| 发送域名 | `$host` |
| 缓存 | 关闭 |

### 步骤 2 · 关键补充配置

反代创建后，配置文件在 `/www/server/panel/vhost/nginx/mesh.example.com.conf`。
宝塔 → 站点 → **配置文件**，确认 `location` 段如下（宝塔默认生成的基本够用，重点确认请求头透传）：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;   # 关键：后端靠它识别 HTTPS
    proxy_http_version 1.1;
    proxy_read_timeout 120s;
    client_max_body_size 10m;
}
```

> `X-Forwarded-Proto` 必须传，因为后端启用了 `trust proxy`，节点接入脚本的默认回连地址由它推导。

### 步骤 3 · 申请证书并强制 HTTPS

站点 → **SSL** → **Let's Encrypt** → 勾选域名 → 申请（自动续签默认开启）。
申请成功后打开「**强制 HTTPS**」开关。

### 步骤 4 · 同步 `CONSOLE_URL`（**最容易漏的一步**）

编辑 `/www/wwwroot/xiangwang-mesh/.env`：

```ini
CONSOLE_URL=https://mesh.example.com
```

重启控制台使配置生效：

```bash
cd /www/wwwroot/xiangwang-mesh && docker compose up -d
```

**验证是否生效**：控制台 → 设备管理 → 新增设备 → 查看「接入方式」中的 Linux 命令，
`curl -fsSL "https://mesh.example.com/api/agent/install.sh?token=..."` —— 域名正确即生效。

### 步骤 5 · 收窄 8080 暴露面（可选但推荐）

做完反代后，8080 端口就不该再对公网开放了。把 `.env` 改为只绑内网：

```ini
HOST_PORT=127.0.0.1:8080
```

同时删除宝塔防火墙里 8080 的放行规则。

---

## 七、首次登录与初始化

1. 打开 `https://mesh.example.com`，用 `.env` 里的 `ADMIN_USER` / `ADMIN_PASSWORD` 登录。
2. **立即改密码**：工作区设置 → 我的账号 → 修改密码。
3. 到「工作区设置」确认工作区名与套餐（自建部署默认 `selfhost`，各项容量上限取得很高，等同不限；另有 `pro` / `free` 两档用于演示上游商业版形态）。
4. 到「网络管理」新建第一个网络，记录**网络密钥**（各节点靠它互相识别）。
5. 到「设备接入密钥」新建密钥 → 在目标设备上执行接入命令。
6. 回到「设备管理」看设备是否上线（约 30 秒内出现状态）。

> 节点上线流程：脚本下载核心 → 注册领令牌 → 拉取 TOML 配置 → **配置预检 8 秒** → 启动核心 → 每 30 秒心跳 + 配置同步。

---

## 八、让这台服务器本身也加入组网（可选）

默认部署的只有控制台。若希望**服务器自己也是 mesh 的一个节点**（比如用它做中继、或让它承担某段子网的代理），启用可选的 `node` 容器。

### 前置检查

```bash
# 1) TUN 设备是否存在
ls -l /dev/net/tun
# 若不存在，加载模块：
modprobe tun
echo "tun" >> /etc/modules-load.d/tun.conf

# 2) 内核转发是否开启
sysctl net.ipv4.ip_forward
#> net.ipv4.ip_forward = 1     ← 需要是 1

# 3) 云服务器是否允许 TUN（部分厂商的容器型实例不支持）
```

> **注意**：宝塔面板自身、以及部分 OpenVZ/LXC 类虚拟化服务器的容器，可能**不允许创建 TUN 设备**。这种情况下 `node` 容器会启动失败，但**控制台不受影响**，照常使用即可。

### 启用

1. 控制台 → 「设备接入密钥」新建一个密钥，复制 `ek_` 开头的值。
2. 编辑 `.env`：

```ini
AGENT_CONSOLE_URL=http://console:8080
ACCESS_KEY=ek_xxxxxxxxxxxxxxxx
```

3. 启动带 `agent` profile 的编排：

```bash
cd /www/wwwroot/xiangwang-mesh
docker compose --profile agent up -d
```

宝塔图形界面下，Docker → 容器编排 → 编辑该编排 → 在**启动参数 / 命令**中追加 `--profile agent`，或直接改用命令行。

### 验证

```bash
docker logs -f xiangwang-node
# 应看到：复用已保存的节点身份 / 已分配虚拟 IP：10.144.144.x / 配置校验通过 / 容器节点已启动

docker exec xiangwang-node easytier-cli -p 127.0.0.1:15888 peer
```

同时控制台「设备管理」会出现一台 `platform=docker` 的设备。

---

## 九、数据持久化与备份

### 数据在哪

| 路径 | 内容 | 重要性 |
| --- | --- | --- |
| `./data/xiangwang.db` | SQLite 主库：用户、网络、设备、密钥、ACL、子网、审计、流量采样 | ⭐⭐⭐ 核心 |
| `./data/xiangwang.db-wal` | WAL 预写日志 | ⭐⭐⭐ 随主库一起备 |
| `./data/xiangwang.db-shm` | 共享内存索引 | ⭐ 可丢弃 |
| `./node-state/` | 可选节点容器的令牌与配置（启用 node 时才有） | ⭐ 丢了重新注册即可 |

**只要 `./data` 目录在，控制台的全部状态就在。**

### 备份

**宝塔图形化**：面板 → **计划任务** → 添加任务：

- 任务类型：`Shell 脚本`
- 任务名称：`湘网组网数据备份`
- 执行周期：每天 03:00
- 脚本内容（**冷备方案，停服约 3 秒，最稳**）：

```bash
#!/bin/bash
cd /www/wwwroot/xiangwang-mesh || exit 1
DST=/www/backup/xiangwang-mesh
mkdir -p "$DST"
STAMP=$(date +%F)

# SQLite 带 WAL，直接 cp 数据库文件可能拷到写一半的状态
# 停服 → 打包 → 起服，凌晨执行影响可忽略
docker compose stop console
tar czf "$DST/xiangwang-$STAMP.tar.gz" data/
docker compose start console

# 只保留最近 14 天
find "$DST" -name 'xiangwang-*.tar.gz' -mtime +14 -delete
echo "备份完成：$DST/xiangwang-$STAMP.tar.gz"
```

**命令行**：

```bash
cd /www/wwwroot/xiangwang-mesh

# 冷备（推荐，最可靠）
tar czf ~/xiangwang-backup-$(date +%F).tar.gz data/

# 热备（不停服，用 SQLite 官方 VACUUM INTO 做一致性快照）
docker exec xiangwang-console node --no-warnings --experimental-sqlite --input-type=commonjs -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/xiangwang.db");
db.exec("VACUUM INTO \x27/data/hot-backup.db\x27");
db.close();
console.log("hot backup done");
'
cp data/hot-backup.db ~/xiangwang-hot-$(date +%F).db && rm -f data/hot-backup.db
```

### 恢复

```bash
docker compose down
mv data data.old && mkdir data
cp ~/xiangwang-backup-2026-09-28.tar.gz . && tar xzf xiangwang-backup-2026-09-28.tar.gz
docker compose up -d
```

---

## 十、升级流程

控制台镜像里的前端是构建时打进去的，所以**升级必须重新构建**：

```bash
cd /www/wwwroot/xiangwang-mesh

# 1) 拉取新代码
git pull

# 2) （重要）先备份数据
docker compose stop console
tar czf ~/xw-backup-$(date +%F-%H%M).tar.gz data/

# 3) 重新构建并启动（down 后 up 保证镜像被替换）
docker compose down
docker compose up -d --build

# 4) 验证
curl http://127.0.0.1:8080/api/health
docker logs xiangwang-console --tail 30
```

宝塔图形界面：Docker → 容器编排 → 编辑 → 重新「部署」。若只改了代码没改 compose，需要先「移除容器」再「部署」才会重建镜像；更稳妥的是走命令行。

**数据库升级是全自动的**：后端启动时会执行 `ensureColumn()` 补齐新增字段并建索引，老库可以直接用新镜像启动，无需手工迁移。

**升级组网核心（EasyTier）版本**：只改 `.env` 的 `ET_VERSION`，然后**重新生成节点接入脚本并让节点重新接入**（已装好的节点不会自动换版本）。

---

## 十一、常见故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 浏览器打不开控制台 | 8080 未放行 | 宝塔安全放行 8080 + 云厂商安全组放行；`docker compose ps` 确认容器 Up |
| 容器反复重启 | 内存不足 / 端口占用 | `docker logs xiangwang-console` 看报错；`ss -lntp \| grep 8080` 查占用进程 |
| 日志出现 `Unknown option --experimental-sqlite` | 基础镜像的 Node 版本过低（< 22.5） | 确认 `Dockerfile` 用的是 `node:22-alpine`；老版本 Docker 拉到了缓存镜像，加 `--no-cache` 重建 |
| 页面能开但接口 502 | 反代指向错误 | 反代目标必须是 `http://127.0.0.1:8080`；宝塔容器若未映射到宿主 8080，需确认 `HOST_PORT` |
| 节点接入脚本回连地址是内网 IP | `CONSOLE_URL` 没配 | 在 `.env` 里填 https 域名并重启控制台 |
| 节点脚本提示 `当前环境没有 systemd` | 在容器里执行了脚本 | Docker 环境请改用「容器节点」方案（本文第八节），systemd 脚本只用于原生 Linux/NAS |
| 核心下载失败（GitHub 超时） | 国内网络 | 脚本已内置 `ghfast.top`、`gh-proxy.com` 镜像回退；仍失败可在服务器上手动下载 zip 放入节点设备 |
| `node` 容器报 `error creating tun device` | 无 TUN 权限或宿主不支持 | 确认 `--cap-add NET_ADMIN --cap-add NET_RAW --device /dev/net/tun`；`modprobe tun`；OpenVZ 类虚拟化不支持，属硬件限制 |
| 节点状态一直「等待接入」 | 节点没跑起来或心跳不通 | 在节点机器上 `journalctl -u xiangwang-node -n 50`；检查节点能否 `curl` 通 `CONSOLE_URL/api/health` |
| 流量曲线是空的 | 采样有 55 秒节流，且需网卡有流量 | 正常现象；设备间真正跑过数据后才会出曲线 |
| 时间显示不对 | 容器时区 | `.env` 里设 `TZ=Asia/Shanghai` 后 `docker compose up -d` 重建 |
| 磁盘持续增长 | 《SQLite WAL + 流量采样》 | 保留策略已在库内按天聚合；如需清理可删 `data/xiangwang.db-wal` 前先停服 |

### 排查三连

```bash
cd /www/wwwroot/xiangwang-mesh
docker compose ps                       # 1. 容器活着吗
docker logs xiangwang-console --tail 80 # 2. 报什么错
curl -i http://127.0.0.1:8080/api/health # 3. 后端自己能通吗
```

再依次排查：`127.0.0.1:8080` 通但域名不通 → **Nginx 反代问题**；域名通但节点接不上 → **CONSOLE_URL / 证书问题**；节点跑起来但控制台看不到 → **心跳出站被防火墙拦截**。

---

## 十二、安全加固清单

上线前逐项确认：

- [ ] `ADMIN_PASSWORD` 已改为强密码，登录后再次修改
- [ ] 已配置域名 + HTTPS，并开启「强制 HTTPS」
- [ ] `.env` 权限为 `600`，且**未被提交到 Git**（`.gitignore` 已排除）
- [ ] `CONSOLE_URL` 已设置为 https 域名
- [ ] 8080 端口不再对公网开放（改为绑定 `127.0.0.1`）
- [ ] 设备接入密钥设置了有效期与设备上限，不用的立即吊销
- [ ] 访问控制（ACL）已按最小权限配置，默认动作设为「拒绝」
- [ ] 已配置每日数据备份计划任务，并**实际验证过恢复流程**
- [ ] 宝塔面板自身已改端口 + 开启双因素 / IP 白名单
- [ ] 定期查看「审计日志」，关注异常登录与配置变更

---

## 附：目录速查

```
/www/wwwroot/xiangwang-mesh/
├── .env                    ← 你的配置（不在 Git 中）
├── .env.example            ← 配置模板
├── docker-compose.yml      ← 编排文件（宝塔「容器编排」指向它）
├── Dockerfile              ← 控制台镜像
├── docker/
│   ├── Dockerfile.node     ← 可选节点镜像
│   └── agent-entrypoint.sh ← 节点容器入口（心跳 + 配置同步）
├── scripts/
│   ├── deploy.sh           ← 一键部署
│   ├── smoke-test.mjs      ← 接口自检（127 项）
│   └── seed-demo.mjs       ← 演示数据
├── data/                   ← ★ 唯一需要备份的目录
└── node-state/             ← 可选节点容器的状态
```

---

**部署完记得回到控制台把这条链路验证一遍**：新建网络 → 建设备接入密钥 → 在一台设备上执行接入命令 → 30 秒内看到设备上线 → 两台设备互相 `ping` 虚拟 IP 通 → 全部打通。至此你这套自建组网平台就跑在自己服务器上了，不依赖 easytier.cn 官方云。
