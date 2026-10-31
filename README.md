<!-- SPDX-License-Identifier: CC-BY-NC-SA-4.0 -->

# dsh-geogebra-bridge-bundle

把 [geogebra-mcp-bridge](https://github.com/myLiLingyun/GeoGebraMCPServer) 这个独立的
MCP stdio 程序接进 DeepSeek Harness 的「**数学模式**」，并给出「**数学模式+**」
（标准模式 ∪ 数学模式）。

它是 DSH 的 **bundle**：`package.json` 里声明 `dsh.bundle.patch`，profile 加载时把
`cordis.patch.yml` 这一层叠到组合上。**它只声明 preset，不带网页插件**：没有
`dsh.client`、没有 `index.js` / `client.js`，也没有画布确认弹窗。

## 下载

| 内容 | 地址 |
| --- | --- |
| 本仓库（DSH 接入层） | <https://github.com/myLiLingyun/GeoGebraDSHPlug> |
| 最新源码 ZIP | <https://github.com/myLiLingyun/GeoGebraDSHPlug/archive/refs/heads/main.zip> |
| MCP server 仓库（必需） | <https://github.com/myLiLingyun/GeoGebraMCPServer> |

本仓库不含 MCP server，也不含 GeoGebra 离线包。

## 它做两件事

1. **声明两个模式**：「数学模式」（`id: math`，`order: 6`）和
   「数学模式+」（`id: math-plus`，`order: 7`）。
2. **在模式的 scope 里接入 GeoGebra 桥**：preset 自己的插件表里挂一行
   `@deepseek-ai/dsh-mcp-client`，用 stdio 启动 `bin/geogebra-mcp-bridge.mjs`，
   于是选了该模式的 Agent 出现 14 个 `mcp__geogebra__*` 工具
   （status / help / objects / object / events / screenshot / view / eval /
   set / edit / state / export / canvas_create / canvas_release），
   其他模式完全看不到这些工具。

MCP 客户端放在 preset 里而不是宿主全局层，是因为 `dsh-mcp-client` 把工具注册在
挂载它的 scope 上：preset 自己挂载的工具只在选中该 preset 的 Agent 面前出现。
宿主全局层没有任何 GeoGebra 工具行。

## 画布流程（不再有确认弹窗）

`canvas_create` 只接受 `app`，**不阻塞、不启动浏览器**，立即返回两行：

```text
id:c1
url:http://127.0.0.1:3460/?canvas=c1&app=classic
```

模型把 `url` 原样告诉用户，请用户用浏览器打开，然后结束本轮；用户下一条消息时，
模型再用 `status` 看页面是否连上，连上后继续 `objects / eval / ...`。
画布保留到 `canvas_release` 或桥进程退出。DSH 里显示的只是聊天气泡里的链接，
没有网页弹窗，也没有 `/api/pending`。

## 仓库结构

```text
package.json        声明 dsh.bundle.patch 与显示元数据
cordis.patch.yml    这一层：preset-math / preset-math-plus 声明与 persona 提示词
test/smoke.mjs      离线自检：清单、YAML 结构、两个 preset、提示词契约
LICENSE             代码与配置许可（GPL-3.0-only）
LICENSE.CC-BY-NC-SA-4.0  文档许可
```

## 依赖

- DSH（`dsh` CLI 或 Desktop），profile 例如 `web`
- Node.js ≥ 20（桥用 `node` 启动）
- [geogebra-mcp-bridge](https://github.com/myLiLingyun/GeoGebraMCPServer) 及其依赖
- GeoGebra 官方离线包（约 32 MB，解压后 100 MB 以上）
- 一个本机浏览器（打开模型给出的画布 url）

## 安装

推荐把两个仓库和离线包放在同一个父目录，默认路径就能全部命中：

```text
geogebra/
├── GeoGebraMCPServer/            ← MCP server 仓库
├── GeoGebraDSHPlug/              ← 本仓库
└── geogebra-math-apps-bundle/    ← GeoGebra 官方离线包
```

### 1. 装 MCP server

```bash
mkdir -p ~/geogebra && cd ~/geogebra
git clone https://github.com/myLiLingyun/GeoGebraMCPServer.git
cd GeoGebraMCPServer
npx --yes pnpm@12 install          # 或 npm install
```

### 2. 下载 GeoGebra 离线包

```bash
cd ~/geogebra
curl -L -o geogebra-math-apps-bundle.zip \
  https://download.geogebra.org/package/geogebra-math-apps-bundle
unzip geogebra-math-apps-bundle.zip -d geogebra-math-apps-bundle
```

### 3. 装本 bundle

```bash
dsh plugin --profile web add ~/geogebra/GeoGebraDSHPlug
```

装完**重启 DSH 进程**。仓库不在 `~/geogebra` 时，启动 DSH 前设置：

```bash
export GGB_BRIDGE_BIN="$HOME/path/to/GeoGebraMCPServer/bin/geogebra-mcp-bridge.mjs"
export GGB_ROOT="$HOME/path/to/geogebra-math-apps-bundle"
```

桌面启动器不继承 shell 的 `export`，这种情况请改 `cordis.patch.yml` 里
`preset-math` / `preset-math-plus` 两处默认值。

### 4. 验证

```sh
dsh --profile web --dump-config | grep -B2 -A12 'preset-math'
ps -eo args | grep geogebra-mcp-bridge
curl -s http://127.0.0.1:3460/api/status
```

`/api/status` 应返回 `{"ok":true,"name":"geogebra-math-bridge",…}`，不再有
`protocol` / `/api/pending` 字段。

### 5. 离线自检

```sh
cd ~/geogebra/GeoGebraDSHPlug
node test/smoke.mjs
```

不需要 DSH 和浏览器；找不到 DSH 安装目录时会自动跳过依赖它的断言。

## 数学模式的工具面

```text
mcp__geogebra__*（14 个，preset 自己挂载的 mcp-client 提供）
todo_write  create_goal  get_goal  update_goal  exit_plan_mode  ask_user_question
subagent  subagent_fork  list_agents  interrupt_agent  send_message  workflow
```

- 第一组流程工具与 MC 模式用的是同一份；
- 第二组是标准模式里 `delegation` 那一组（含 `workflow`，与
  `isolate: { workflowEngine: true }` 一起放在一个 `cordis:group` 里）；
- `mcp__geogebra__*` 来自 preset 自己挂载的 mcp-client。

**系统提示词整段替换**（`@deepseek-ai/dsh-persona`，`complete: true` +
`includeRuntimeContext: false`）：宿主基线提示词、工作目录、运行时上下文、工具引导
都不会追加，会话的系统提示词就是 patch 里那段 prefix，只讲「节奏」和「任务」。

提示词里明确要求：`canvas_create` 后把 url 告诉用户、结束本轮，不要轮询 status，
不要重复建画布；用户下一条消息后再用 status 检查连接。

## 数学模式+（标准模式 ∪ 数学模式）

`id: math-plus`，显示名「数学模式+」，`order: 7`。它和标准模式只差两处：

| | 标准模式 | 数学模式 | 数学模式+ |
| --- | --- | --- | --- |
| 工具面 | 标准模式那一份 | 流程工具 + GeoGebra | 标准模式那一份 + `mcp__geogebra__*` |
| 系统提示词 | 基线 + persona prefix + 工具引导 + 运行时上下文 | 只有 persona prefix（`complete: true` 整段替换） | 基线 + **拼接后的 persona prefix** + 工具引导 + 运行时上下文 |

**工具面**：patch 里把 shipped 的标准模式 `plugins` 原样抄了一份，再在 `persona`
后面插进数学模式的 `mcp-geogebra`。**preset 之间没有继承机制**，所以这是抄件：
标准模式哪天加行，`test/smoke.mjs` 的并集断言会红，照着补一行就行。

## 改完怎么生效

- 改 `cordis.patch.yml` / `package.json`：禁用再启用 bundle，或直接**重启 DSH 进程**；
- 改 MCP server：杀掉桥进程（mcp-client 会拉起新进程），或重启 DSH；
- 改本 README：不需要重启。

## 已知注意事项

- 桥只监听 `127.0.0.1`；浏览器、agent 客户端与 MCP 服务器必须在同一台设备上。
- 同时装「数学模式」和「数学模式+」时，profile 会拉起两个桥进程（端口 3460 → 3461）。
  这是 preset 各自挂载 mcp-client 的结果；想只留一个就重启 DSH。
- 画布不会超时自动释放；完成或放弃时让模型调 `canvas_release`，或重启桥。
