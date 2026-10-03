# 湘网组网 · 桌面 / 移动客户端设计方案

> 目标：**装完客户端，输入（或扫）一个接入码就连上** —— 不再手抄网络名称 / 密钥 / 对等节点。

本文档记录方案与**可行性边界**。边界部分是实测得出的，不是估计。

---

## 一、体验定义

### 现在的样子（要被替换掉的）

```
装 EasyTier 官方 GUI → 新建网络 → 手动模式
  → 网络名称：xiangwang-office        ← 抄
  → 网络密码：xwlemd123               ← 抄
  → 对等节点：tcp://et.xwlemd.com:55555 ← 抄
  → 运行网络
```

三行参数，抄错一个字符就连不上，而且报错信息不会告诉你错在哪。

### 目标样子

```
安装湘网组网客户端 → 粘贴/扫描接入码 → 连接
```

**一个输入项，零参数。**

### 交互流程

```
  控制台（管理员）
  ┌──────────────────────────────┐
  │ 接入密钥「张三的笔记本」       │
  │                              │
  │   接入码  XW-7K2M-9Q4T  [复制]│
  │                              │
  │   ┌──────────┐               │
  │   │ ▓░▓░ QR  │  扫码即接入    │
  │   └──────────┘               │
  └──────────────────────────────┘
                 │
                 │ 用户把码发给对方 / 对方扫码
                 ▼
  ┌───────────────────────────────────────────┐
  │  客户端                                    │
  │  ① 解析接入码 → 控制台地址                  │
  │  ② GET /api/agent/register?key=…          │
  │     → NODE_TOKEN / VIRTUAL_IP / CONFIG_URL │
  │  ③ GET CONFIG_URL → 完整 config.toml       │
  │  ④ 落盘 + 启动 easytier-core -c config.toml│
  │  ⑤ 每 30 秒 POST /api/agent/heartbeat      │
  │  ⑥ 配置版本变了 → 重新拉取并热重启内核       │
  └───────────────────────────────────────────┘
```

**②③⑤⑥ 这四步已经在服务端实现并且实测通过了**（见第六节）。客户端不需要理解 EasyTier 的任何内部细节 —— 它只是个「拿到 toml、跑内核、报心跳、听指令」的壳。

---

## 二、平台可行性矩阵（实测）

本机（Windows 10/11 x64）的实际工具链状况：

| 工具 | 状态 |
| --- | --- |
| Node.js 22 / 24 | ✅ 可用 |
| Python 3.13 | ✅ 可用 |
| .NET | ⚠️ **只有运行时，无 SDK** —— 编译不了 C# |
| Go / Rust / Java / Gradle | ❌ 未安装 |
| Android SDK / NDK / adb | ❌ 未安装 |
| MSVC / gcc / clang / cmake | ❌ 未安装 |
| macOS / Xcode | ❌ **不存在（这是硬阻断）** |

据此：

| 平台 | 能否做 | 卡在哪 | 我能否在本机验证 |
| --- | --- | --- | --- |
| **Windows** | ✅ **已验证可行** | 用 Electron（纯 npm，不需要编译器） | **能** —— 实测已跑通（见第十节） |
| **Android** | ⚠️ 能但重 | 要装 JDK + Android SDK + Gradle（约 2GB）；官方 JNI **无预编译产物**，必须自己用 Rust + NDK 交叉编译，且官方文档写明需要 **Linux/macOS 开发环境** | **只能盲写** —— 无 SDK、无真机、无模拟器 |
| **iOS** | ❌ **做不了** | 必须 macOS + Xcode + Network Extension，且要过 App Store 审核 | 完全不可能 |

### iOS 这条要说清楚

官方 EasyTier 有 iOS 客户端，但**只在海外区 App Store 上架**（需要外区 Apple ID）。
我们自己做 iOS 客户端需要：一台 Mac + 开发者账号（$99/年）+ Network Extension 权限申请 + 审核。

**在你这台 Windows 机器上无法推进。** 三条出路：
1. 暂不做 iOS，iPhone 用户用官方海外区客户端（手填参数，或用「配置服务器」模式填一个地址）；
2. 买/借一台 Mac（或租云 Mac），我可以在那边继续；
3. 走 TestFlight 内测分发（仍需 Mac）。

---

## 三、接入码

### 为什么不能直接用现在的 `ek_` 密钥

```
ek_0ee16b2a03d96775a754f8fa617e8f65     ← 35 字符十六进制
```

手机上手输这个是不现实的。所以引入一个**短码 + 深链**的双层设计：

| 形态 | 样子 | 用途 |
| --- | --- | --- |
| 完整密钥 | `ek_0ee16b…8f65` | 程序对接（脚本、CI） |
| **短接入码** | `XW-7K2M-9Q4T` | **人抄写、口述** |
| **深链** | `xwmesh://join?c=XW7K2M9Q4T&s=https%3A%2F%2F…` | 点一下直接拉起客户端 |
| **二维码** | 上面那条深链 | **手机扫一下**（主要方式） |

设计要点：

- **短码去掉易混字符**（`0/O`、`1/I/L`），用 Crockford Base32 字母表 → 用户口述不会错
- 短码**不是**密钥的哈希，是独立字段 `access_keys.short_code`，可在不改密钥的前提下重新生成
- 深链里带控制台地址，客户端**不需要预配置服务器** —— 换机器、换域名都不用改客户端
- 深链里的地址必须由控制台**自己推导**（复用现有的 `CONSOLE_URL || req.get('host')` 回退逻辑），不能写死

### 二维码放在哪

控制台「接入密钥 → 接入方式」里新增一个二维码区块，替换现在那段要手抄的文本。同时保留纯文本形态（发给别人、贴到群里）。

---

## 四、客户端状态机

```
        ┌──────────────┐
        │  未接入       │  空界面：一个输入框 + 「粘贴接入码」
        └──────┬───────┘
               │ 解析接入码
               ▼
        ┌──────────────┐
        │  注册中       │  GET /api/agent/register
        └──────┬───────┘
         失败  │  成功（拿到 NODE_TOKEN + VIRTUAL_IP）
        ┌──────┴───────┐
        ▼              ▼
   ┌─────────┐   ┌──────────────┐
   │ 接入失败 │   │  连接中       │  拉 config.toml → 起内核
   │ 显示原因 │   └──────┬───────┘
   └─────────┘          │
                        ▼
                 ┌──────────────┐
                 │  已连接       │  显示虚拟 IP / 在线设备数 / 流量
                 └──┬────────┬──┘
                    │        │
        管理员停止   │        │ 内核崩溃
                    ▼        ▼
             ┌───────────┐  ┌──────────┐
             │ 已被停止   │  │ 重试中    │
             │ 说明原因   │  │ 指数退避  │
             └───────────┘  └──────────┘
```

**「已被停止」必须是一等状态，不能只弹个错误。** 实测：管理员在控制台点「停止设备」后，
心跳立即返回 `{"ok":false,"revoked":true,"reason":"节点已被管理员停止"}`，
拉配置返回 `403 # node blocked`。这是控制台对设备的管控权，客户端必须尊重它并且**明确告知用户原因**，
而不是傻傻重试。

同样，密钥过期 / 被吊销 / 达到设备上限，都要区分原因显示（`keyBlockReason()` 已经给了中文原因，直接透传）。

---

## 五、技术选型

### Windows

| 方案 | 体积 | 是否需要编译器 | 结论 |
| --- | --- | --- | --- |
| **Electron** | 安装包 ~90MB | ❌ 不需要（预编译二进制） | ✅ **选它** —— 本机唯一能真正构建出来的路 |
| Tauri | ~10MB | ✅ 需要 Rust | ❌ 本机无 Rust |
| .NET WPF | ~60MB | ✅ 需要 .NET SDK | ❌ 本机只有运行时 |
| Go + systray | ~10MB | ✅ 需要 Go | ⚠️ 可下载 Go zip 绕过，但托盘需 cgo |

**进程结构**：

```
湘网组网.exe (Electron 主进程)
  ├── 窗口：连接界面（Vue 3，复用控制台那套风格）
  ├── 子进程：easytier-core.exe -c %APPDATA%\xiangwang\config.toml
  ├── 定时器：心跳 / 配置版本比对
  └── 托盘：显示状态、断开、退出
```

**内核从哪来**：不打包进安装包（安装包会从 90MB 涨到 130MB）。
首次连接时按需下载 `easytier-windows-x86_64-v2.6.4.zip`，解压到 `%APPDATA%\xiangwang\core\`，
校验 SHA256 后使用。**但国内直连 GitHub 会慢** —— 所以下载地址要可配置，
默认走控制台的 `/api/agent/redirect/download` 跳转（将来可以指向自己的镜像）。

**权限**：创建 TUN 网卡需要管理员权限。做法是安装时以管理员注册，
运行时用计划任务以最高权限启动内核 —— 不能让用户每次点「连接」都弹 UAC。

### Android

```
Kotlin App
  ├── VpnService（系统级 VPN，负责把流量接进 TUN）
  ├── easytier-android-jni（官方 crate，提供 JNI 接口，不用自己交叉编译 Rust）
  ├── 前台服务（保活，Android 会杀后台）
  └── 扫码（CameraX + ML Kit）→ 解析 xwmesh:// 深链
```

**这条路的风险要说清楚**：
- 需要装 JDK + Android SDK + Gradle（约 2GB）
- **我在本机无法运行验证** —— 没有 SDK、没有模拟器、没有真机
- VPN 类应用的保活、省电策略、各厂商 ROM 适配，是**必须真机调**的活
- 结论：能写出来，但**必须你在真机上跑、把日志给我，我来改**。这个循环会很慢。

### iOS

见第二节，当前不可行。

---

## 六、服务端已经具备的能力（实测证据）

我用真实服务实测了一遍客户端要走的全部接口：

**① 拿接入码换令牌**

```
GET /api/agent/register?key=ek_0ee16b…8f65&hostname=DESKTOP-TEST&arch=windows-x86_64

→ HTTP 200
NODE_TOKEN=6f76dcfa42ebac72711cec82aa8f019edc5f50a0d76448af
NODE_NAME=DESKTOP-TEST
VIRTUAL_IP=10.66.0.2
NETWORK_NAME=client-net-evjka
RPC_PORT=15888
CONFIG_URL=http://127.0.0.1:8099/api/agent/config?token=6f76dcfa…
```

**② 拉配置 —— 直接就是一坨可用的 toml**

```
GET /api/agent/config?token=…

→ HTTP 200 text/plain
instance_name = "default"
hostname = "DESKTOP-TEST"
instance_id = "c9a36212-c0b1-4b7b-8420-eaef67cbd39f"
ipv4 = "10.66.0.2"
dhcp = false
rpc_portal = "127.0.0.1:15888"

[network_identity]
network_name = "client-net-evjka"
network_secret = "secevjkaevjka"

[[peer]]
uri = "tcp://et.xwlemd.com:55555"

[flags]
default_protocol = "tcp"
dev_name = "xwtun0"
enable_encryption = true
mtu = 1380
latency_first = true
…
```

**客户端要做的事只有一件：把这段文本写进 `config.toml`，然后 `easytier-core -c config.toml`。**

**③ 心跳**

```
POST /api/agent/heartbeat
→ {"ok":true,"revoked":false,"configVersion":1,"serverTime":"…","syncInterval":30}
```

`syncInterval: 30` 是服务端下发的建议心跳间隔，客户端照此执行即可。

**④ 管控闭环（这是最关键的一条）**

管理员在控制台点「停止设备」之后：

```
心跳 → {"ok":false,"revoked":true,"reason":"节点已被管理员停止"}
拉配置 → HTTP 403  # node blocked
```

**控制台对设备有真实管控权**，客户端必须响应并断开、且把原因显示给用户。

---

## 七、服务端还需要补什么

| 项 | 说明 | 工作量 |
| --- | --- | --- |
| `access_keys.short_code` 短码字段 | Crockford Base32、去易混字符、可重新生成 | 小 |
| `GET /api/agent/join?code=…` | 短码 → 与 register 等价的结果（供深链调用） | 小 |
| 控制台二维码区块 | 「接入方式」里生成深链二维码，替换手抄文本 | 小 |
| `GET /api/client/latest` | 客户端版本检查与下载地址（可指向自建镜像） | 小 |
| 安装包分发 | 放哪？GitHub Releases 国内慢，建议挂自己服务器 | 待定 |

前四项都是小改动，加起来半天。**做完之后即使用官方客户端也能受益**（官方 GUI 支持「配置服务器」模式，只需填一个地址）。

---

## 八、分阶段计划

| 阶段 | 内容 | 产出 | 风险 |
| --- | --- | --- | --- |
| **S1** | 服务端：短码 + `join` 接口 + 二维码 + 自检 | 控制台能给出可扫的接入码 | 低 |
| **S2** | Windows 客户端：Electron 壳 + 内核管理 + 状态机 + 托盘 | 可安装的 `.exe` | 中（内核提权、下载慢） |
| **S3** | 打包分发：NSIS 安装包 + 版本检查 | 一个下载链接 | 中（放哪、国内下载） |
| **S4** | Android 客户端 | `.apk` | **高**（无法本机验证，需你真机回归） |
| **S5** | iOS | — | **当前不可行** |

**建议先做 S1 + S2**：做完你就能在自己的 Windows 上用上「填一个码就连上」的客户端，
而且 S1 的产出能让手机端立刻受益（官方客户端填一个地址）。

---

## 九、明确不做的

写在最后，避免期望错位：

- ❌ **不做自己的组网内核**。内核永远是 EasyTier 官方的 —— 我们自己写一个 P2P 打洞 + 加密隧道内核
  是不现实的，也毫无必要。客户端是**壳**。
- ❌ **不会绕过控制台的管控**。被管理员停止的设备，客户端会真的断开并显示原因。
- ❌ **不承诺 iOS**，直到有 Mac。
- ⚠️ **不做「免安装、双击即用」的单文件**（单文件无法稳定管理 TUN 与常驻进程），
  走正常的安装包路线。

---

## 十、实测记录：Windows 工具链到底能不能用

上面第二节那张表是**实测出来的**，不是估计。过程与坑记录在此，换机器可照做。

### 结论：Windows 客户端的整条工具链可用

| 环节 | 结果 |
| --- | --- |
| Electron 二进制下载 | ✔ 188 MB，走 npmmirror **14 秒** |
| Electron 运行时 | ✔ **v33.4.11** / Chrome 130 / Node 20.18 |
| 离屏窗口 + DOM 读取 | ✔ `RUNTIME_OK` + `DOM_OK` |
| electron-builder 安装 | ✔ 334 个包，**17 秒** |
| 打包依赖（NSIS / winCodeSign） | ✔ 镜像上均返回 200 |

**「离屏窗口 + `executeJavaScript` 读 DOM」这条路能跑通**，意味着客户端界面我可以在本机自动验证，
不必依赖你人工点。

### 三个坑（换环境一定会再遇到）

**坑 1：GitHub 直连拿不到二进制**

```
FAIL  https://github.com/electron/electron/releases/     ← TimeoutError
200   https://npmmirror.com/mirrors/electron/            ← 可用
```

Electron 的 npm 包只有几百 KB，**真正的二进制是 postinstall 阶段从 GitHub 下的**，
所以 `npm install electron` 会「成功」但 `node_modules/electron/dist` 是空的。

```bash
# 正确姿势
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm i electron@33
# 或者事后补：
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js

# electron-builder 同理
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

**判定「装成功没」的唯一可靠方法**：看 `node_modules/electron/dist/electron.exe` 在不在，
**不要看 npm 的退出码**。

**坑 2：`ELECTRON_RUN_AS_NODE=1` 会静默劫持 Electron**

这台机器上（以及任何 IDE / 编辑器派生的终端里）这个变量是被设上的。
后果非常隐蔽：

```
electron.exe --version   →  v20.18.3      ← 打出的是 Node 版本，不是 Electron 版本
require('electron')      →  变成 npm 包（一个字符串路径）
app.whenReady()          →  TypeError: Cannot read properties of undefined
```

排查口诀：**`electron --version` 打出来的是 Node 版本 → 就是被劫持了。**

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe --version
# → v33.4.11   ✔
```

**坑 3：无显卡环境必须关 GPU**

沙箱 / 无头 / 远程桌面环境下，GPU 进程会反复崩：

```
ERROR:gpu_process_host.cc  GPU process exited unexpectedly: exit_code=-1073741819
FATAL:gpu_data_manager_impl_private.cc  GPU process isn't usable. Goodbye.
```

`0xC0000005` 是访问违例。修法（只影响我方验证，发布版不需要）：

```js
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-software-rasterizer')
app.commandLine.appendSwitch('no-sandbox')
```

### 对交付的影响

**安装包放哪，是个真问题。** GitHub Releases 在你这网络下直连超时，
客户端安装包（约 90 MB）不能指望它。候选：

1. **挂在你的 NAS / 生产服务器上**，用控制台的 `/api/client/download` 转发 —— 推荐，反正服务器本来就在
2. 阿里云 OSS / 腾讯云 COS + CDN
3. GitHub Releases + 国内加速前缀

第 1 条最省事，而且客户端本来就要连你的服务器。

---

## 十一、手机端最快见效的一条路（不用等客户端）

研究过程中发现一个**可以立刻落地**的方案，独立于自研客户端。

EasyTier 官方 GUI 和 App 都支持**「配置服务器」模式** —— 源码里是 `config_server_url` 一个输入框，
启动核心时转成 `--config-server <url>`。**只需填一个地址，不用填网络名 / 密钥 / 对等节点。**

而官方文档给了自建控制台的标准做法：

```bash
docker run -d --entrypoint easytier-web-embed \
  -v /yourpath/data:/app \
  -p 11211:11211 -p 22020:22020/udp \
  easytier/easytier:latest

# 国内直连不了 docker.io 时用 DaoCloud 镜像
docker pull m.daocloud.io/docker.io/easytier/easytier:latest
```

节点（含官方 GUI）接入方式：

```bash
easytier-core --config-server udp://<host>:22020/<用户名>
# protocol 可选 udp / tcp / ws；ws 被反代为 wss 时填 wss
```

**于是在控制台容器旁边多起一个 `easytier-web-embed`，暴露 22020，
XW-Mesh 的接入方式页把这一条地址显示出来 —— 手机装官方 App、粘一个地址，就连上了。**

代价与限制：
- 这样接入的节点由 `easytier-web` 管，**不在 XW-Mesh 的「设备管理」里**（需要做同步才能进）
- 需要额外一个容器的资源，以及 22020 的公网暴露（UDP，或反代 ws→wss）
- 与自研客户端是**互补**关系：临时用这个，长期靠客户端

**建议**：这条可以顺手做掉，让手机端今天就有改善；自研客户端按 S1→S2 推进。
