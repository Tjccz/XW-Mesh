# 架构设计

本文描述**已实现**的架构与关键取舍，不是选型提案。

---

## 一、总体分层

```
┌──────────────────────────────────────────────────────────────┐
│  湘网组网控制台（自研 · 可闭源）                                │
│  Vue 3 前端  +  Express API  +  SQLite（node:sqlite）          │
│  职责：网络编排 · 设备纳管 · 密钥签发 · 子网路由 · ACL 编译      │
│        配置快照 · 审计留痕 · 流量采样 · 用量统计                 │
└───────────────────────────┬──────────────────────────────────┘
                            │ ① 下发：GET /api/agent/config → TOML
                            │ ② 上报：POST /api/agent/heartbeat（30s）
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  节点（客户设备 / 我们的服务器）                                │
│  节点代理（POSIX Shell，systemd timer 或容器入口）              │
│        └──▶  easytier-core（官方二进制，原样运行，读 config.toml）│
└───────────────────────────┬──────────────────────────────────┘
                            │ ③ 数据面：P2P 打洞直连 / 中继
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  其他节点 · 被代理的内网段                                      │
└──────────────────────────────────────────────────────────────┘
```

**核心原则：控制面全自研，数据面直接用上游。**

数据面（NAT 穿透、加密、路由）是 EasyTier 投入最大的部分，自研既无意义也做不过；控制面（编排、权限、观测、场景适配）才是产品差异所在。因此：

- 控制台**不依赖任何 EasyTier 私有接口**（不使用其 `-w` Web 协议），上游怎么变都不影响控制面
- 上游只以「一个读 TOML 的二进制度」的形式被调用，属于**进程间调用**而非代码衍生

---

## 二、配置下发通道

### 2.1 三方案对比与选型

| 方案 | 做法 | 结论 |
| --- | --- | --- |
| A. 复用 `easytier-web` 协议 | core 用 `-w` 连我们的控制台，由我们实现其配置下发服务端 | ❌ 私有协议，需跟随上游演进，被绑死 |
| B. 自研通道 + 命令行参数 | 推参数、重启 core | ⚠️ 参数多起来后无法表达子网与 ACL |
| **C. 自研通道 + 完整 TOML 文件** | 控制台生成 `config.toml` → 节点下载 → 预检 → 替换 → 重启 | ✅ **采用** |

选 C 的原因：子网代理（`[[proxy_network]]`）与访问控制（`[[acl.acl_v1.chains]]`）**只能由配置文件表达**，命令行参数做不到。既然要支持对标能力，就必须下完整配置文件。

### 2.2 完整 TOML 结构（实际生成）

```toml
instance_name = "办公室NAS"
hostname      = "office-nas"
instance_id   = "3f2a...（由节点令牌 sha256 推导的稳定 UUID）"
ipv4          = "10.144.144.6"
rpc_portal    = "127.0.0.1:15888"

listeners = ["tcp://0.0.0.0:11010", "udp://0.0.0.0:11010",
             "wg://0.0.0.0:11011", "ws://0.0.0.0:11011"]

[network_identity]
network_name   = "xiangwang-office"
network_secret = "……"

[[peer]]
uri = "tcp://public.easytier.cn:11010"

[[proxy_network]]
cidr = "192.168.88.0/24"

[flags]
default_protocol           = "tcp"
dev_name                   = "xwtun0"
enable_encryption          = true
enable_ipv6                = true
mtu                        = 1380
latency_first              = true
disable_p2p                = false        # 中继模式为 relay 时置 true

# ---- 由访问控制规则编译出的 ACL 片段 ----
[[acl.acl_v1.chains]]
chain_type     = 3            # 1 入站 / 2 出站 / 3 转发
default_action = 2            # 1 允许 / 2 拒绝

  [[acl.acl_v1.chains.rules]]
  action      = 1
  protocol    = 1             # 0 未指定 / 1 tcp / 2 udp / 3 icmp / 4 icmpv6 / 5 任意
  priority    = 200           # 数字越大越先匹配
  source_ips  = ["10.144.144.0/24"]
  destination_ips = ["192.168.88.0/24"]
  ports       = ["443", "22"]
  stateful    = true
```

> **核实来源**：该结构对照上游实际解析逻辑核实过。网上大量教程写的 `[[acl.acl]]` + 字符串动作是**错误**的，正确写法是 `[[acl.acl_v1.chains]]` + 整数枚举，且 `priority` 是**数字越大越先匹配**（与多数防火墙直觉相反）。

### 2.3 节点身份：免新增字段的稳定 `instance_id`

`instance_id` 必须是稳定 UUID（重装、重启都不能变，否则会被视为新节点）。这里没有给 `nodes` 表加字段，而是：

```js
identityOf(node):
  若 nodes.identity 已有值 → 直接返回（保留人工指定能力）
  否则 = uuidFrom( sha256("xw-mesh:" + node.token) )
        取十六进制前 32 位，套上 UUID v4 的版本位与变体位
```

好处：无状态、无额外存储、天然唯一、令牌不变则身份不变。代价：令牌轮换会换身份——但令牌轮换本就等同于换设备，语义正确。

### 2.4 防掉线：三步保护

配置下发最大的风险是「推送了一个坏配置，把远端设备弄下线」。三道闸：

| 闸门 | 机制 |
| --- | --- |
| **变更通知** | 管理员改配置 → 该网络内所有设备的 `config_version` 递增，代理 30 秒内感知 |
| **配置预检** | 代理发现文件有变 → 先 `timeout 8 core -c new.toml` **试跑 8 秒**；退出码 124/143/130 视为「跑满超时未退出 = 配置合法」 |
| **原子替换 + 回滚** | 预检通过才 `cp 旧配置 → config.bak`、替换文件、重启；**预检失败则删除新配置，原配置继续运行** |

这套机制的实测效果：推送一个语法错误的 ACL 后，设备**不重启、不掉线**，控制台侧留下 `preflight.log` 供排查。

### 2.5 吊销联动

密钥吊销或设备被「停止」后，心跳接口返回：

```json
{ "ok": false, "revoked": true, "reason": "接入密钥已被吊销" }
```

代理收到后 `systemctl stop + disable` 主服务与定时器并退出。**吊销是强制的**，不需要人工登录设备处理。

---

## 三、多租户与权限

所有资源表带 `workspace_id`，所有查询强制带该过滤条件。

```
ROLE_RANK = { viewer: 1, member: 2, admin: 3, owner: 4 }
```

| 角色 | 查看 | 重启/重发配置 | 增删改资源 | 成员与工作区设置 |
| --- | :-: | :-: | :-: | :-: |
| viewer 只读 | ✅ | ❌ | ❌ | ❌ |
| member 成员 | ✅ | ✅ | ❌ | ❌ |
| admin 管理员 | ✅ | ✅ | ✅ | ❌ |
| owner 拥有者 | ✅ | ✅ | ✅ | ✅ |

写操作统一走 `requireMinRole('admin')` / `requireMinRole('owner')` 中间件，而不是散落在各路由里手写判断。

**老库平滑升级**：新表结构加了 `workspace_id` 后，老实例的早期用户没有 owner，工作区设置页会无人可用。`ensureBootstrap()` 中加了自动补位：若某工作区没有 owner，把其中最早的管理员提升为 owner。

**默认套餐为 `selfhost`**：这是自建部署，配额只用于「演示上游商业版形态」，不应成为实际限制，因此该档上限取得足够高（等同不限）。

---

## 四、访问控制编译

控制台存的是**人话**（动作、协议、IP 段、端口、优先级），下发前编译成**枚举整数**：

```js
const PROTOCOL_CODE = { any: 5, tcp: 1, udp: 2, icmp: 3, icmpv6: 4 }
const ACTION_CODE   = { allow: 1, deny: 2 }
const CHAIN_TYPE    = { inbound: 1, outbound: 2, forward: 3 }
```

规则排序：`ORDER BY priority DESC, id ASC`，与上游「数字越大越先匹配」的语义对齐。

**不做 `group` 身份体系**：上游 ACL 支持基于 group 的规则，但需要把 group 密钥分发到全网设备。对自建场景成本高、收益低，因此控制台只做纯 IP 段策略，界面也不暴露 group 概念。

**编译预览**：前端提供「编译预览」弹窗，直接展示将要下发的 TOML 片段，可复制或下载 `.toml`。这样管理员改规则时能立刻看到实际生效的样子，而不是靠猜。

**指纹**：每次快照同时记录 ACL 片段的 sha1 前 12 位（`aclFingerprint`），便于快速判断「两台设备的 ACL 是否一致」。

---

## 五、状态与流量采集

### 5.1 心跳

代理每 30 秒 `POST /api/agent/heartbeat`，上报：主机名、核心版本、邻居数、平台、出口 IP、网卡累计收发字节。

邻居数来自 `easytier-cli -p 127.0.0.1:15888 peer` 的行数统计（减掉表头）。

### 5.2 节点状态判定

`statusOf(node)` 依据最后心跳时间分档：

| 状态 | 条件 |
| --- | --- |
| `online` | 120 秒内有心跳（`ONLINE_WINDOW_MS`；心跳间隔 30 秒，即容错 4 次） |
| `offline` | 超过 120 秒无心跳 |
| `pending` | 从未上报过心跳（已发令牌但设备未接入） |
| `blocked` | 被管理员主动停止，或被吊销密钥联动置位（该状态**优先于**时间判定） |

### 5.3 流量：累计值 + 差分

设备上报的是网卡**累计字节**（单调递增计数器），不是区间增量。存储侧：

- `traffic_samples` 表存每次采样的累计值
- **最小采样间隔 55 秒**（`TRAFFIC_INTERVAL_MS`），防止心跳频率调高后写放大
- 查询时对相邻采样做**差分**得到区间流量；计数器回绕时按新值计算

这个设计的好处：采样可以丢、可以稀疏，只要有一条基线就能算；坏处：需要查询侧做差分，所以流量统计逻辑集中在 `routes/metrics.js` 与 `routes/usage.js`，不散落。

### 5.4 为什么不直接用 RPC 采集

RPC 只在节点本机可访问（`127.0.0.1:15888`），控制台无法直连（除非暴露端口，那会带来安全风险）。因此统一由节点侧代理主动上报，控制台永远不需要入站访问设备——**这对 NAT 后面的设备是硬性要求**。

### 5.5 告警：对账，而不是在写入路径埋钩子

告警最容易写错的地方是「在哪触发」。直觉做法是在改数据时顺手发一条通知（比如设备心跳超时就发），但这条路有三个躲不掉的坑：

| 坑 | 后果 |
| --- | --- |
| 漏发 | 心跳是设备推上来的，控制台重启期间没人推数据，谁来判断「已经离线超过 10 分钟」？ |
| 重发 | 设备离线后每 30 秒一次心跳超时检查，会连发几十条同样的告警 |
| 扩展成本 | 每加一类事件（磁盘满、证书到期…）都要回到业务写入路径里插代码 |

**采用的做法：周期性对账（reconcile）。** 扫描器不关心「什么变了」，只回答「此刻哪些条件成立」：

```
每 60 秒：
  1. 遍历所有启用规则 → 算出「此刻应当告警」的目标集合 expected
  2. 查库中所有 firing 事件 → actual
  3. expected − actual → 新触发（建事件 + 投递 + 静默期抑制）
     actual − expected → 条件已消失（置 resolved + 发恢复通知）
```

这个模型同时解决了三件事：

- **漏发不存在**：判断权在控制台，与设备是否上报无关
- **重发天然不存在**：已在 `firing` 的目标不在差集里，不需要额外的去重逻辑
- **新增事件类型只加一个求值器**：写一个纯函数 `(rule, ctx) => 命中目标[]` 并注册进 `EVALUATORS`，不碰任何业务代码

**这个模型的代价**：告警有最多 60 秒的检测延迟；以及**必须保证幂等**——同一轮重复执行不能产生副作用，否则每轮都会重复建事件。这也是为什么 `scanWorkspace()` 里所有写操作都是「先查后写」。

**一个容易被忽略的连带要求**：演示/测试数据必须与真实条件对齐。`seed-demo.mjs` 回填告警事件时用的是**真实设备与密钥的 ID**，并且只造「条件确实成立」的事件——否则 60 秒后对账扫描会把这些事件全部判为已恢复。这是对账模型下写测试数据必须遵守的规则。

---

## 六、数据模型

```
workspaces      工作区：name / slug / plan
users           成员：username / password_hash / salt / role / workspace_id / display_name
networks        网络：name / secret / cidr / peers / template / region / relay_mode / workspace_id
nodes           设备：network_id / name / virtual_ip / token / status / last_seen /
                      core_version / peer_count / platform / reported_ip / config_version /
                      workspace_id / access_key_id / rx_bytes / tx_bytes / subnet_proxy /
                      identity / dev_name / last_traffic_at / registered_at
node_configs    配置快照：node_id / version / config_json / note / created_by
access_keys     接入密钥：key / status / expires_at / max_nodes / used_count /
                      register_count / network_id / workspace_id
subnet_routes   子网路由：network_id / node_id / cidr / description / workspace_id
acl_rules       访问控制：name / action / protocol / chain_type / src_cidr / dst_cidr /
                      ports / priority / enabled / workspace_id
traffic_samples 流量采样：node_id / rx_bytes / tx_bytes / peer_count / sampled_at
alert_channels  通知渠道：name / type / config_json / enabled / last_status / last_error /
                      last_test_at / workspace_id
alert_rules     告警规则：name / event_type / threshold / network_id / level / channel_ids /
                      silence_minutes / enabled / workspace_id
alert_events    告警事件：rule_id / rule_name / event_type / level / target_type / target_id /
                      target_name / message / status / deliveries / fired_at / resolved_at /
                      ack_at / ack_by / workspace_id
audit_logs      审计日志：username / action / target_type / target_id / detail / ip / workspace_id
```

**设计取舍：**

| 取舍 | 说明 |
| --- | --- |
| `node_configs.config_json` 存整个配置 JSON | 保证任意历史版本可完整还原；配置文件本身很小（几 KB），不会造成存储压力 |
| `subnet_routes` 与 `nodes.subnet_proxy` 并存 | 前者是关系表（前端好查询、好展示），后者是冗余字段（生成 TOML 时避免 JOIN） |
| `alert_events.rule_name` 与 `rule_id` 同时存 | 规则被删除后历史事件仍要能读——审计性质的数据不能让引用变成悬空 |
| `alert_events.deliveries` 存 JSON 快照 | 投递明细是「当时发生了什么」的证据，不能随后续渠道改名/改配置而变化 |
| 迁移一律走 `ensureColumn()` | 增量补列 + `CREATE INDEX IF NOT EXISTS`，**不引入迁移框架**，老库直接启动即完成升级 |
| 索引必须在补列之后创建 | 老库的 `workspace_id` 列由 `ensureColumn` 补齐，若索引语句写在其前会报 `no such column` —— 这是实现中踩过的坑 |

---

## 七、配额模型

```
free     2 网络 / 20 设备 / 5 密钥 / 1 条 ACL / 3 成员 / 1 天监控
pro      5 网络 / 50 设备 / 20 密钥 / 5 条 ACL / 30 成员 / 7 天监控
selfhost 999 网络 / 999 设备 / 99 密钥 / 99 条 ACL / 99 成员 / 30 天监控
```

`free` / `pro` 两档对齐上游商业版的形态，在「工作区设置」中可切换，用于**演示与对比**。`selfhost` 是自建部署的默认档，上限取得足够高（等同不限），**自建部署不应该被自己的配额卡住**。

检查点在创建资源时统一调用 `checkQuota(workspaceId, plan, resource, adding)`，返回结构化提示文本或 `null`，而不是抛异常——这样路由层能直接 `if (err) return res.status(400).json({ error: err })`。

---

## 八、为什么不分叉 EasyTier

三条理由，任何一条都足够：

1. **许可证**：LGPL-3.0 下，修改本体并分发就要开源修改部分，直接影响商业化自由度
2. **维护成本**：上游迭代很快（2.4 → 2.6 仅数月），fork 之后每次都要人工合并
3. **没有收益**：产品价值在管理层，不在协议层

**唯一的适配边界**：控制台只依赖「`easytier-core -c config.toml`」这一个稳定接口。上游只要不改配置格式，控制面就不受影响；即使改了，也只需调整 `services/config.js` 的生成逻辑，且**新旧核心可以共存**（`ET_VERSION` 可配）。

---

## 九、部署形态

| 形态 | 组件 | 适用 |
| --- | --- | --- |
| 宝塔面板 + Docker | `console` 容器（必需）+ 可选 `node` 容器 | 推荐生产 |
| 裸机 | 后端直接跑 + 宝塔 Nginx 反代前端产物 | 已有 Node 环境 |
| 开发 | 后端 8080 + Vite dev server 5173 | 本地调试 |

控制台镜像用**多阶段构建**：

- 构建阶段用 `node:22-slim`（Debian/glibc）——**因为 Vite 依赖的 esbuild / rollup 没有 musl 构建产物，在 alpine 上会构建失败**
- 运行阶段用 `node:22-alpine`——运行期只有 express + cors 两个纯 JS 依赖，无原生模块

运行时数据全部落在 `/data`（容器内）→ 映射到宿主 `./data` 目录。**备份只需拷这一个目录。**

节点侧有两种托管方式，逻辑同源：

| 方式 | 入口 | 进程托管 |
| --- | --- | --- |
| 原生 Linux / NAS | `templates/node-install.sh` 生成的脚本 | systemd service + timer |
| 容器 | `docker/agent-entrypoint.sh` | sh 主循环守护子进程 |

两者都实现：配置预检、心跳上报、流量采集、配置同步、吊销联动。容器版额外支持「用接入密钥首次注册后把令牌落盘，重启不重复占号」。

---

## 十、风险与对策

| 风险 | 对策 |
| --- | --- |
| 上游改配置格式或行为 | 控制面只依赖 `core -c config.toml`，格式变更只影响 `services/config.js`；`ET_VERSION` 可配，新旧版本可共存 |
| 上游许可证再变更 | 锁定已用版本、升级前核对 LICENSE、保留旧版二进制 |
| 下发坏配置导致设备失联 | 三步保护：版本比对 → 8 秒预检 → 失败不替换（见 2.4） |
| 中继带宽成本失控 | 默认 `relay_mode=auto` 优先 P2P；强制中继需显式配置；用量视图可监控 |
| 控制台被入侵 | 反代 + HTTPS、仅内网监听 8080、最小权限角色、审计全留痕 |
| 被指「套壳」 | 明确声明使用 EasyTier 开源核心；把力气花在上游没有的场景化能力上（子网可视编排、ACL 编译预览、配置快照回滚、统一用量与审计） |
| SQLite 单点 | WAL 模式 + 每日备份；数据量与并发规模远未到需要换库的程度，过早引入 PostgreSQL 只是运维负担 |
