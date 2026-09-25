# 阿露 Agent 调教

包名：`pi-alu-agent-tuner`。仓库地址：`aruru-project/pi-alu-agent-tuner`。已有本地安装可保留原目录名，避免影响路径依赖。

一个 Pi 扩展，提供三项能力：

- 为所有模型注入工程纪律，并为 `*-sol` 模型追加 Sol 专项纪律；
- 当 `gpt-5.6-sol` 或 `gpt-6-astra` 在工具回合后超过 token 阈值时，先停止、压缩上下文，再自动继续任务；仅匹配这两个准确模型 ID；
- 独立的 `/codex-fast` 当前会话开关，对 Codex 请求指定 Fast 服务档位。

如果 Pi 已原生提供同类的回合后停止能力，插件会自动让位。

## 配置

插件依次读取两层配置：全局代理目录中的 `alu-agent.json`（通常是 `~/.pi/agent/alu-agent.json`），以及当前项目工作目录中的 `.pi/alu-agent.json`。不会查找父目录。

只读取 `alu-agent.json`，命令统一保存到全局同名文件并保留其他字段。启动只读取配置。

### 一次性配置迁移

更新前，将全局代理目录的 `alu-sol.json` 重命名为 `alu-agent.json`；各项目已有的 `.pi/alu-sol.json` 同样重命名为 `.pi/alu-agent.json`，文件内容保持原样，以保留已有的 450k 阈值、`disable` 和其他字段。若目标文件已存在，先核对并合并所需字段，避免覆盖已有设置。完成后执行 `/reload`，用 `/alu-agent status` 确认。

此迁移需单独执行，插件不自动迁移，也不读取旧文件名。命令统一改用 `/alu-agent`，旧 `/alu-sol` 和 `/alu-sol-status` 已移除。

上下文保护只使用全局配置的 `guardEnabled` 和 `guardThreshold`；项目层的 guard 字段不生效。纪律配置 `disable` 保留项目覆盖：字段缺失或值无效时保留全局值，`disable: []` 可清空全局禁用项。任一文件缺失或 JSON 格式错误时只忽略该层，未知字段不参与运行。

所有配置仅在 Worker 启动、`/reload`、`/new` 时读取，包括工程纪律；逐消息、逐回合均不重新读取。当前开关和阈值仅保存在本次会话运行内，不写入会话历史，也不绑定 Dock 实例；恢复历史会话时同样从全局默认初始化。已有会话保持各自设置，直到重新初始化。

未配置时兼容原有行为：`disable=[]`、`guardEnabled=true`、`guardThreshold=250000`。已有的全局阈值（例如 `450000`）保持有效，启动插件不会改写配置。

配置文件可包含：

```json
{
  "disable": ["sol-discipline"],
  "guardEnabled": false,
  "guardThreshold": 450000
}
```

`disable` 只控制纪律提示词注入，支持：

- `engineering-discipline`：不注入通用工程纪律；
- `sol-discipline`：不注入 Sol 专项纪律；
- `all` 或 `*`：两种纪律都不注入。

`all` 和 `*` 也不会关闭上下文保护。`guardEnabled` 是保护的全局默认开关，必须为布尔值。`guardThreshold` 是全局默认触发阈值，必须是 JavaScript 可精确表示的正整数；缺失或无效时使用 `250000`。Sol 和 Astra 共用此阈值，在工具回合完成后检查用量，不预测下一回合的预算，因此仍可能跨过模型的加价线。

## 安装

从 GitHub 安装：

```bash
pi install https://github.com/aruru-project/pi-alu-agent-tuner
```

也可克隆后安装本地仓库：

```bash
git clone https://github.com/aruru-project/pi-alu-agent-tuner.git
cd pi-alu-agent-tuner
pi install "$(pwd)"
```

安装或更新后，在 Pi 中运行 `/reload`，再用 `/alu-agent status` 查看当前保护开关和阈值。状态栏仅在压缩时临时显示进度。

临时试用本地源码：

```bash
pi -e ./index.ts
```

## 从旧版迁移

GitHub 仓库现名为 `aruru-project/pi-alu-agent-tuner`，旧名为 `pi-alu-sol-tuner`，更早为 `pi-sol-temp-ext`。旧链接可能会重定向；Git 安装来源改用新地址，本地路径安装保持原路径，并按上文完成一次性配置迁移。安装新版前仍应移除已安装的 `pi-sol-temp-ext` 或 `sol-mid-turn-guard`。旧 guard 与新版插件会挂接同一条保护路径，不能同时加载，否则可能冲突。

1. 运行 `pi list`，找到旧包，并用列表中显示的完整来源或路径执行 `pi remove`；不要自行改写来源。
2. 如果旧版是手动复制的，删除 `~/.pi/agent/extensions/sol-mid-turn-guard`。
3. 在 Pi 中运行 `/reload`。
4. 运行 `pi install https://github.com/aruru-project/pi-alu-agent-tuner` 安装新版。
5. 再次运行 `/reload`。

## 命令

```text
/alu-agent on                 # 仅开启当前会话保护
/alu-agent off                # 仅关闭当前会话保护
/alu-agent default on         # 保存全局默认开启（也支持 off）
/alu-agent threshold 800k      # 立即修改当前阈值，并保存全局默认阈值
/alu-agent threshold 1.05m     # 等价于 1050000 tokens
/alu-agent status             # 查看当前开关、阈值、保护阶段及配置生效时机
/alu-agent help
```

`/alu-agent` 无参数时显示状态。阈值支持正整数或十进制加 `k`/`m`（不区分大小写），换算后必须是正整数 tokens。仅在 Sol/Astra 指定模型的工具回合结束时触发保护；`off` 后已经开始的压缩续跑会完成，后续回合停止触发本插件保护。纪律注入和 Pi 自身的自动压缩不受此开关影响。

### Codex Fast（独立命令）

```text
/codex-fast on       # 当前会话开启
/codex-fast off      # 当前会话关闭
/codex-fast status   # 查看当前开关及当前模型是否适用
```

默认关闭；每次启动新会话、`/reload`、`/new` 后重置为关闭。只存在当前会话内存，不写配置或会话历史，不影响 `/alu-agent`、thinking 或 text verbosity。开启时，仅当当前模型的 provider 为 `openai-codex` 且 api 为 `openai-codex-responses`，在实际请求中添加 `service_tier: "priority"`（Codex 订阅线路的 Fast 档位），不更改模型 ID；不按模型 ID 设置白名单，由上游决定模型是否接受该档位。若上游拒绝，请按 Pi 显示的请求错误处理；插件不会降级重试。该开关仅请求 Fast 档位，不保证订阅服务实际兑现；尚未使用真实订阅调用验证。状态栏仅在开关开启且当前模型适用时显示 `codex-fast`，切走清空，切回恢复。

`/alu-agent` 的 `on/off` 不写全局；`default on/off` 只保存未来初始化的默认开关，当前会话开关保持原值。`threshold` 保存成功后立即更新当前阈值，其他已存在会话保持原阈值。写入保留全局配置的其他字段；格式错误或写入失败会明确报错，当前设置保持原值，请修复配置/权限后重试。

例如全局为 off/450k，A、B 启动后，在 A 执行 `on`、`threshold 800k`：A 为 on/800k，B 为 off/450k，全局为 off/800k。A 或 B 执行 `/reload`、`/new` 后变为 off/800k。

## 验证

系统中已全局安装 Pi 时运行：

```bash
npm run smoke
```

使用 Dock 内嵌或其他非全局安装的 Pi 时，可指定包目录：

```bash
PI_CODING_AGENT_ROOT=/path/to/node_modules/@earendil-works/pi-coding-agent npm run smoke
```

测试覆盖独立 `/codex-fast` 命令、模拟请求档位及状态栏切换、重载/新会话开关复位、统一 `/alu-agent` 命令入口与配置文件名、纪律注入与初始化快照、全局 guard 默认、A/B 会话隔离、命令保存及报错、无逐轮热加载、Sol/Astra 停止/压缩/续跑和重载安全。`test/smoke.mjs` 使用真实 Pi 扩展加载器及 Agent 回合钩子，事件上下文、压缩与续跑发送为测试替身。`test/lifecycle.mjs` 进一步使用真实 SDK 命令分发、`AgentSession.reload()` 和 `AgentSessionRuntime.newSession()`（Pi 0.84.2 内置命令使用的生命周期入口）验证重新初始化；UI 和模型查询为替身，不运行交互终端、不调用模型服务。所有配置均在临时目录，测试结束清理。请以普通用户运行，权限失败用例会实际将临时配置目录设为只读。

## 移除

先运行 `pi list`，再将列表中显示的完整来源或路径原样传给 `pi remove`：

```bash
pi list
pi remove 'pi list 显示的完整来源或路径'
```

移除后运行 `/reload`。

## License

[MIT](LICENSE)
