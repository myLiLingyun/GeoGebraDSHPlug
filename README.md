<!-- SPDX-License-Identifier: CC-BY-NC-SA-4.0 -->

# dsh-geogebra-bridge-bundle

把 [geogebra-mcp-bridge](https://github.com/myLiLingyun/GeoGebraMCPServer) 这个独立的
MCP stdio 程序接进 DeepSeek Harness 的「**数学模式**」，并在此基础上给出
「**数学模式+**」（标准模式 ∪ 数学模式）。

它是 DSH 的 **bundle**：一个 npm 包，`package.json` 里声明 `dsh.bundle.patch`，
profile 加载时把 `cordis.patch.yml` 这一层叠到组合上。它同时是一个 **双面包**
（`dsh.bundle` + `dsh.client`）：宿主半边是 `index.js`，浏览器半边是 `client.js`。

## 下载

| 内容 | 地址 |
| --- | --- |
| 本仓库（DSH 插件） | <https://github.com/myLiLingyun/GeoGebraDSHPlug> |
| 最新源码 ZIP | <https://github.com/myLiLingyun/GeoGebraDSHPlug/archive/refs/heads/main.zip> |
| MCP server 仓库（必需） | <https://github.com/myLiLingyun/GeoGebraMCPServer> |

```bash
git clone https://github.com/myLiLingyun/GeoGebraDSHPlug.git
```

本仓库只是 DSH 的接入层，**不含 MCP server，也不含 GeoGebra 离线包**；两者都要按
[安装](#安装) 里的步骤单独准备。

## 它做三件事

1. **声明两个模式**：两个 `@deepseek-ai/dsh-agent-preset` 声明——「数学模式」
   （`id: math`，`order: 6`，排在标准 / PTC / 极简 / 创造 / MC 之后）和
   「数学模式+」（`id: math-plus`，`order: 7`，见下文）。
2. **在模式的 scope 里接入 GeoGebra 桥**：preset 自己的插件表里挂一行
   `@deepseek-ai/dsh-mcp-client`，用 stdio 启动 `bin/geogebra-mcp-bridge.mjs`，
   于是选了该模式的 Agent 出现 14 个 `mcp__geogebra__*` 工具
   （status / help / objects / object / events / screenshot / view / eval /
   set / edit / state / export / canvas_create / canvas_release），
   其他模式完全看不到这些工具。
3. **建画布时在网页界面弹确认框**（`geogebra-bridge-ui`）：见下一节。

MCP 客户端放在 preset 里而不是宿主全局层，是因为 `dsh-mcp-client` 把工具注册在
挂载它的 scope 上：preset 自己挂载的工具只在选中该 preset 的 Agent 面前出现。
这比「全局注册 + 在每个模式里逐个 deny」更稳——以后新增的模式不会漏网，也不需要
在别处维护一份隐藏名单。宿主全局层没有任何 GeoGebra 工具行。

## 「打开画布」确认框（geogebra-bridge-ui）

`canvas_create` 建好画布之后默认**不立刻返回**：它先在桥里登记一条请求并挂住这次
工具调用，等用户真的把画布打开、再在弹窗里点「已打开，继续」才返回。

```
Agent: canvas_create {app:"classic"}
   │
   ├─ 桥：建好 c1，登记 /api/pending 里的一条请求，挂住这次调用（默认最多 5 分钟）
   │
   ├─ 浏览器（本包 client.js，注册在 shell.overlay）每 1–4 秒轮询
   │    GET /api/dsh-geogebra-bridge/pending        ← 本包 index.js 的同源代理
   │      └─ 扫 3460..3479，只认自报 name+protocol>=2 的桥
   │
   ├─ 弹窗出现：蓝色可点的画布地址 + 实时连接状态
   │    「已打开，继续」按钮在页面真的连上之前是灰的；另有「跳过，先继续」
   │
   ├─ 用户点开地址 → GeoGebra 页面连回桥 → 弹窗状态变「页面已连上 · GeoGebra …」
   │
   └─ 用户点「已打开，继续」
        POST /api/dsh-geogebra-bridge/confirm {id, action:"opened", bridge}
          └─ 代理转发到那座桥的 /api/pending/confirm → 挂住的调用解除，工具返回
```

三条兜底，保证任何情况下都不会把模型卡死：

| 情况 | 结果 |
| --- | --- |
| 用户点「跳过，先继续」或按 Esc | 工具立刻返回 id，并说明用户跳过了 |
| 没人在看弹窗（界面插件不在 / 标签页关了） | 等约 4 秒后走**老路径**：本进程自己试 `firefox`/`xdg-open`，拉不起就把地址给用户 |
| 弹窗在，但用户一直没点 | 默认 5 分钟后超时返回 id，提示用 `status` 看连接状态；`confirmTimeoutMs` 可调 |

`headless: true` 或 `confirm: false` 直接跳过确认框（自动化验证用）。

弹窗是**浮在顶部的卡片，不是挡满屏幕的模态**：`shell.overlay` 那一层本来就被设计成
click-through（占用者自己 opt-in pointer events），所以卡片之外的地方照常能点——
Agent 等确认的这几分钟里，你仍然可以看对话、按停止、切别的会话。Esc 等同于「跳过」，
免得出现一个按不掉的卡片。

这个功能是**可选加法**：桥本身依旧是独立的 MCP 程序，不带这个 bundle 时
`canvas_create` 就是老行为（自己拉起浏览器或把地址交给你）。桥侧协议见
[GeoGebraMCPServer 的 README](https://github.com/myLiLingyun/GeoGebraMCPServer#readme)
的「确认框」一节。

## 样式表归属（踩过的坑，别再踩）

客户端模块系统（`dsh-client-modules`）在 **materialize** 时会做两件事：

```js
styles: claimStyles(ownerId)   // 把文档里所有【没有 data-plugin 的 <style>】标成 ownerId
...
removeOwnedStyles(id)          // HMR 替换 / bundle 从图上摘掉时：删掉所有 style[data-plugin=id]
```

`claimStyles` 是「刚 materialize 的插件注入了哪些样式」的猜测，它不区分作者。所以：

- **自己的 `<style>` 一定要标上自己的包名**（`data-plugin="dsh-geogebra-bridge-bundle"`）：
  不标的话，下一个 materialize 的插件会把它认领走，那个插件一重载/一禁用，我们的弹窗就没样式了。
- **不要把 `<style>` 渲染进 React 树**：那是运行时才出现的、无标记的元素，正好落在
  `claimStyles` 的认领范围里。
- **反过来也要守规矩**：如果我们（或任何插件）在别人的样式还没标记时 materialize，
  会把人家的样式认领成自己的，之后自己一重载就把人家的样式删了——
  实测就是这样把 `dsh-account-insight` 的余额胶囊打成无样式的（弹窗出现前后、
  HMR/切换 bundle 时触发，刷新即恢复，因为它的 `apply` 会重建样式表）。
  它的修法同样是给自己的 `<style>` 加 `data-plugin="dsh-account-insight"`。

现在的做法：

- `ensureStyle()` 在 `apply` 里把一张带 `id` 与 `data-plugin="dsh-geogebra-bridge-bundle"`
  的 `<style>` 插进 `document.head`，返回移除函数并登记进 `ctx.effect`；
- 弹窗组件本身不含任何 `<style>`；
- 再加一道保险：`releaseForeignStyleClaims()` 把标着**我们包名**、但不是我们那张样式表的
  元素还原成未标记（只去掉 harness 误加的标记，不碰内容），在 `apply` 里和 materialize
  后的微任务里各跑一次。这样即使别的插件没守规矩，我们也只是「没认领成功」，不会把它删掉。

前两条由 `bundle/test/smoke.mjs` 断言；`dsh-account-insight` 那边的
`test/smoke.mjs` 也加了一条「样式表带 `data-plugin`」的断言。

> 顺带一提：这个是 harness 的归属猜测机制（`claimStyles`）本身不够精确，不是 account-insight
> 独有的问题——任何用 `document.createElement('style')` 且不加 `data-plugin` 的浏览器插件
> 都会中招。规则就一句：**样式要么在 materialize 时注入、要么自己标上包名。**

## 仓库结构

```
package.json        声明 dsh.bundle.patch、dsh.client 与显示元数据
cordis.patch.yml    这一层：geogebra-bridge-ui 宿主行 + preset-math / preset-math-plus 声明
index.js            宿主半边：发现桥 + /api/dsh-geogebra-bridge/{pending,confirm,status} 代理
client.js           浏览器半边：shell.overlay 上的确认弹窗（__ModuleLoader__ 契约产物）
routes.js           路由表的唯一事实源（client.js 里是同一份字面量，smoke 会断言）
test/smoke.mjs      离线自检：清单、两端契约、路由一致性、patch 结构、数学模式+ 的并集
LICENSE             代码与配置许可（GPL-3.0-only）
LICENSE.CC-BY-NC-SA-4.0  文档许可
```

## 依赖

- DSH（`dsh` CLI 或 Desktop），profile 例如 `web`
- Node.js ≥ 20（桥用 `node` 启动）
- [geogebra-mcp-bridge](https://github.com/myLiLingyun/GeoGebraMCPServer) 及其依赖
- GeoGebra 官方离线包（约 32 MB，解压后 100 MB 以上）
- 一个本机浏览器（用弹窗里的链接打开查看器地址，或手工打开）

## 安装

推荐把两个仓库和离线包放在同一个父目录，默认路径就能全部命中：

```
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
test -f geogebra-math-apps-bundle/GeoGebra/deployggb.js && echo OK
```

也可以从 <https://www.geogebra.org/download> 下载 “GeoGebra Math Apps Bundle”。
**离线包不要提交进 git**，两个仓库的 `.gitignore` 都已排除它。

### 3. 装本 bundle

```bash
cd ~/geogebra
git clone https://github.com/myLiLingyun/GeoGebraDSHPlug.git
dsh plugin --profile web add ~/geogebra/GeoGebraDSHPlug
```

如果习惯在 DSH 会话里操作，也可以用插件管理工具：

```
plugin_manager install_bundle /home/you/geogebra/GeoGebraDSHPlug
```

装完**重启 DSH 进程**，让 profile 重新加载 patch。

### 4. 路径不对时

默认值按上面的 `~/geogebra` 布局写死为：

- 桥：`~/geogebra/GeoGebraMCPServer/bin/geogebra-mcp-bridge.mjs`
- 离线包：`~/geogebra/geogebra-math-apps-bundle/`

装在别处时，在**启动 DSH 的那个环境**里设置：

```bash
export GGB_BRIDGE_BIN="$HOME/opt/GeoGebraMCPServer/bin/geogebra-mcp-bridge.mjs"
export GGB_ROOT="$HOME/opt/geogebra-math-apps-bundle"
dsh --profile web
```

或者直接改 `cordis.patch.yml` 里 `mcp-geogebra` 那两行的默认值
（`preset-math` 和 `preset-math-plus` 各一处）。桌面启动器不会继承 shell 的
`export`，这种情况请改 patch 里的默认值，或把变量写进桌面启动项。

桥的端口由桥自己决定（默认 3460，被占用就顺延），宿主半边按
`basePort`（默认取 `GGB_BRIDGE_PORT`，否则 3460）+ `ports`（默认 20）扫一遍，
一般不用配。

### 5. 验证

```sh
dsh --profile web --dump-config | grep -B2 -A12 'preset-math'
curl -s http://127.0.0.1:3080/api/dsh-geogebra-bridge/status   # 端口按你的 DSH web 服务改
```

装好后 profile 加载时会直接拉起桥（preset 的子插件在加载时就挂载）：

```sh
ps -eo args | grep geogebra-mcp-bridge        # 应该有 node …/bin/geogebra-mcp-bridge.mjs
curl -s http://127.0.0.1:3460/api/status      # {"ok":true,"name":"geogebra-math-bridge","protocol":2,…}
```

### 6. 离线自检

```sh
cd ~/geogebra/GeoGebraDSHPlug
node test/smoke.mjs
```

不需要 DSH 和浏览器；找不到 DSH 安装目录时会自动跳过依赖它的断言。

## 数学模式的工具面

工具面完全等于下面这份清单（这套部署里宿主全局层的工具行都是 `disabled`，
没有继承来的工具需要过滤）：

```
mcp__geogebra__*（14 个，preset 自己挂载的 mcp-client 提供）
todo_write  create_goal  get_goal  update_goal  exit_plan_mode  ask_user_question
subagent  subagent_fork  list_agents  interrupt_agent  send_message  workflow
```

- 前两组（流程工具）与 **MC 模式**用的是同一份；
- 第三组是标准模式里 `delegation` 那一组（含 `workflow`，与
  `isolate: { workflowEngine: true }` 一起放在一个 `cordis:group` 里）；
- `mcp__geogebra__*` 来自 preset 自己挂载的 mcp-client。

**系统提示词整段替换**（`@deepseek-ai/dsh-persona`，`complete: true` +
`includeRuntimeContext: false`）：宿主基线提示词、工作目录、运行时上下文、工具引导
都不会追加，会话的系统提示词就是 patch 里那段 prefix，只讲「节奏」和「任务」；
每个工具怎么用由工具自己的说明负责，具体算什么交给用户在对话里说。

## 数学模式+（标准模式 ∪ 数学模式）

`id: math-plus`，显示名「数学模式+」，`order: 7`。它和标准模式只差两处：

| | 标准模式 | 数学模式 | 数学模式+ |
| --- | --- | --- | --- |
| 工具面 | 标准模式那一份 | 流程工具 + GeoGebra | 标准模式那一份 + `mcp__geogebra__*` |
| 系统提示词 | 基线 + persona prefix + 工具引导 + 运行时上下文 | 只有 persona prefix（`complete: true` 整段替换） | 基线 + **拼接后的 persona prefix** + 工具引导 + 运行时上下文 |

**工具面**：patch 里把 shipped 的标准模式 `plugins` 原样抄了一份（bash / pwsh、
fs、fs-search、jobs、skill、web、present，目标 / 待办 / 提问 / 计划，压缩组，
子 Agent / workflow 组），再在 `persona` 后面插进数学模式的 `mcp-geogebra`。
**preset 之间没有继承机制**，所以这是抄件：标准模式哪天加行，
`test/smoke.mjs` 的「标准模式的 18 行工具/流程都在，且配置逐字相同」会红，
照着补一行就行。反过来，数学模式那一份的 `mcp-geogebra` 与流程行也逐字比。

**系统提示词**：两边的 persona prefix 首尾相接放进同一个 `prefix`——
下面是标准模式那句，空一行，接数学模式那一整段（要求 / 画布 / 界面 / 节奏 / 任务）：

```yaml
prefix: |-
  You are a coding agent powered by the {{model}} model.

  你正在和一个浏览器里的 GeoGebra（离线包 5.4.932.1）配合做数学：…
```

`suffix` 沿用标准模式的 `Your working directory is {{cwd}}.`。

这里**刻意不设 `complete: true`**（数学模式才设）。`complete` 会把宿主基线提示词、
工具引导、运行时上下文和 plan-mode 的 section 全部抹掉——标准模式的提示词本来就不只是
persona 的 prefix，还包含这些。要让「标准模式的提示词」完整在场，就必须走标准模式的
装配方式，再把数学模式那段 persona 接在标准 prefix 后面。代价是数学模式那段话不再独占
整段提示词：它排在基线之后、工具引导之前，与标准模式的 prefix 相邻。

`plan-mode` 的 `section` 用的是标准模式那一份（它在标准模式里本来就进提示词）；
数学模式那份中文短句在数学模式里因为 `complete: true` 从不出现，两边不冲突。

### 数学模式+ 会多起一座桥

preset 的子插件在 profile 加载时就挂载，和「当前选了什么模式」无关。所以这一行会让
profile 里多出一套 `mcp-client` + 桥进程：数学模式的桥占第一个空端口，数学模式+ 的桥
顺延到下一个（实测 3464 / 3465 这样成对出现）。宿主半边按端口段扫出所有带确认协议的桥、
弹窗把它们的 `/api/pending` 合并，确认时按 `bridge` 字段原路送回，所以多桥共存时弹窗
依然接得对；每个会话连的是自己 scope 里那一个，不会串。想回到只有一个桥，重启 DSH 进程。

## 改了之后怎么生效

四种改动，生效方式各不相同（都是实测结论）：

| 改了什么 | 怎么生效 |
| --- | --- |
| `server/` 里的桥代码 | **不用重启 DSH**：杀掉桥进程，preset 里的 mcp-client 会把它拉回来，新进程就是磁盘上的新代码（见下） |
| `client.js`（浏览器半边） | **不用重启**：`dsh-client-hmr` 每轮 stat 一遍各行的客户端 bundle，改动会推到已连的页面并重新 materialize |
| `index.js` / `routes.js`（宿主半边） | **要重启 DSH**：宿主插件的 ESM 模块世代被缓存，禁用再启用 bundle 不会重新 import（实测：加在 `index.js` 里的新字段在开关之后依然不出现） |
| `cordis.patch.yml`（尤其新增行） | **要禁用再启用 bundle**：这一层没有 HMR 监听。包已安装时 `plugin_manager install_bundle` 会因为安装源不一致报 `ambiguous-install`，用开关切换即可 |

改 `cordis.patch.yml` 时在 DSH 里用插件管理器把该 bundle 先禁用再启用（`set_bundle`）：

```
plugin_manager set_bundle dsh-geogebra-bridge-bundle enabled=false
plugin_manager set_bundle dsh-geogebra-bridge-bundle enabled=true
```

> ⚠ **实测（2026-10-14）：开关不会干净地替换 `mcp-client` 那一行。**
> 禁用确实让 `Config.listConfigs` 里的 `include:preset-math` 消失，但**已经挂载的
> mcp-client 与它拉起的桥进程会留下来**（把它杀掉，mcp-client 还会把它重启回来）。
> 再启用就多出第二套 mcp-client + 第二个桥进程；后者的查看器端口顺延
> （3460 → 3461），会话究竟连的是哪一个变得不确定。功能上两边都能用，
> 但端口会漂，也看不出哪个是没人用的。
>
> 好在这个插件的宿主半边会**按端口段扫出所有带确认协议的桥**，界面弹窗把它们的
> `/api/pending` 合并起来，并在确认时按 `bridge` 字段原路送回——所以多桥共存时
> 弹窗依然接得对；但**改动 `mcp-client` 那一行，或者想回到干净状态，就重启 DSH 进程**。
> 改完确认一下有几个桥：

```sh
ps -eo pid,args | grep geogebra-mcp-bridge     # 干净状态只应有一个，且占用 3460
curl -s http://127.0.0.1:3460/api/status
```

桥在 MCP 通道关闭时会自己退出并释放端口（见
[GeoGebraMCPServer](https://github.com/myLiLingyun/GeoGebraMCPServer)），
但那只覆盖「mcp-client 真的消失」的情况，覆盖不了上面这种「mcp-client 还在、只是被重新挂载」。

**只改了 `server/` 里的代码（没动 patch）时**，把桥进程杀掉即可，实测 2 秒内重启，
端口仍是 3460，浏览器里已打开的页面会自动重连、画布内容不丢：

```sh
kill $(ps -eo pid,args | awk '/[g]eogebra-mcp-bridge/ {print $1}')
sleep 3 && ps -eo pid,args | grep '[g]eogebra-mcp-bridge'   # 应出现新的 pid
```

注意 `awk '/[g]eogebra/…'` 里的方括号是为了让这条命令**不要匹配到自己**——
`pkill -f geogebra-mcp-bridge` 会连发起它的那个 shell 一起杀掉。

## bundle 自检

```sh
cd bundle && node test/smoke.mjs
```

不需要 DSH、也不需要浏览器：检查清单（`dsh.bundle.patch`、`exports["./client"]`、
`dsh.client.platform`）、两端契约（`__ModuleLoader__.load` 的 id 必须等于包名、
只 require 基线模块）、路由字面量与 `routes.js` 一致、`cordis.patch.yml` 能被
YAML 解析且 `!!js` 表达式还在、`toolCallTimeoutMs` 大于确认框的等待上限。

数学模式+ 那几条会从 DSH 安装目录读 shipped 的
`@deepseek-ai/dsh-web-app/presets/standard.patch.yml` 做并集比对：prefix 必须逐字
等于「标准 prefix + `\n\n` + 数学 prefix」，标准模式每一行工具/流程都要在且
`name`/`disabled`/`config` 逐字相同，数学模式的非分组行与分组子行也都要在。
找不到安装目录（或没有 js-yaml）时这几条会打印一行说明并跳过，不算失败。

## 排查挂载问题

`plugin_manager list_plugins` 里 `include:preset-math` 的 `fiberPhase: active`
只说明**声明行**挂载了，不代表里面的子插件挂载成功——`agentPresets.register()`
会捕获子插件挂载失败并记进 preset 的 `broken` 诊断，外层行照样是 active。要看真实
状态，读 `ctx.agentPresets.list()`（前端「Agent 预设」页面用的是同一个方法，每行带不
带 `broken` 一眼可见），或者直接看进程：preset 健康时会有
`node …/bin/geogebra-mcp-bridge.mjs` 子进程，坏掉时没有。

## 参考

- 打包与安装（官方）：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md>
- bundle 与 profile 的区别：bundle 是「贡献一层配置的 npm 包」，profile 是
  「哪些 bundle、按什么顺序组成一套可运行组合」；后面的层按行 id 覆盖前面的层，
  且**整段**替换该行的 `config`。

## 许可证

- **代码与配置**（`cordis.patch.yml`、`package.json`、`index.js`、`client.js`、`routes.js`、`test/`）：GPL-3.0-only，见 [LICENSE](LICENSE)
- **文档**（`README.md` 及其他 `.md`）：CC BY-NC-SA 4.0，见 [LICENSE.CC-BY-NC-SA-4.0](LICENSE.CC-BY-NC-SA-4.0)
