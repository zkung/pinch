# pinch

一个面向 OpenClaw 的零依赖 Node CLI，用来管理 `~/.openclaw/openclaw.json` 里的第三方 OpenAI 兼容模型。

后续需手动重启 OpenClaw 网关：

```bash
openclaw gateway restart
```

`pinch` 的目标很简单：**不用手改 JSON，也能完成模型的添加、发现、测试、切换默认模型、安全删除和备份恢复。**

适合这些场景：

- 想快速接入新的 OpenAI 兼容 provider
- 已经有 provider，想先查看远端有哪些模型可用
- 想验证某个已配置模型现在还能不能正常响应
- 想切换默认模型，但不想手动编辑 `openclaw.json`
- 想删除旧模型，同时避免误删仍被默认模型或 Agent 引用的配置
- 想查看 `openclaw.json.bak.*` 备份、手动补一份备份，或回滚到某次备份

## 特性

- 零依赖，直接基于 Node.js 运行
- 自动复用已有 provider，或按 `base_url` 自动生成 provider id
- 支持通过远端 `/models` 自动发现可用模型并添加
- 支持按模型别名或 `modelRef` 测试模型可用性
- 支持按模型别名或 `modelRef` 切换默认模型
- 删除前自动检查 `agents.defaults.model` 和 `agents.list[*].model` 的引用关系
- 写入前自动备份原始配置文件
- 支持列出、查看、手动创建和恢复 `openclaw.json.bak.*` 备份
- `list` 会聚合显示 provider 中的模型，并标记当前默认模型

## 安装

### 从 npm 安装

```bash
npm install -g @zkung/pinch
```

安装后可直接使用：

```bash
pinch --help
```

### 本地开发安装

```bash
npm install -g .
```

### 不安装直接运行

```bash
node bin/pinch.js --help
```

## 使用前提

- 需要 Node.js 18 或更高版本
- 默认配置文件路径是 `~/.openclaw/openclaw.json`
- 如需操作其他配置文件，可使用 `--config /path/to/openclaw.json`

## 快速开始

### 1）手动添加一个模型

```bash
pinch add https://api.example.com/v1 sk-xxxx gpt-4.1 gpt41
```

### 2）从已有 provider 自动发现模型并添加

```bash
pinch add --discover https://api.example.com/v1 gpt-4.1 gpt41
```

### 3）查看当前模型和默认模型

```bash
pinch list
```

示例输出：

```text
Current default: gpt41 (provider-a/gpt-4.1)
DEFAULT  ALIAS  MODEL               NAME     BASE_URL
-------  -----  ------------------  -------  --------------------------
yes      gpt41  provider-a/gpt-4.1  gpt-4.1  https://api.example.com/v1
-        -      provider-a/gpt-4.1-mini  gpt-4.1-mini  https://api.example.com/v1
```

### 4）测试某个模型是否可用

```bash
pinch test gpt41
pinch test provider-a/gpt-4.1
```

### 5）切换默认模型

```bash
pinch default gpt41
pinch default provider-a/gpt-4.1
```

### 6）删除模型

```bash
pinch del gpt41
pinch del provider-a/gpt-4.1
pinch del --force gpt41
```

### 7）查看和恢复备份

```bash
pinch backup
pinch backup show 20260307123456
pinch backup add
pinch backup restore 20260307123456
```

## 命令速查

| 命令 | 作用 |
| --- | --- |
| `pinch add` | 手动添加模型 |
| `pinch add --discover` | 从远端 `/models` 发现模型并添加 |
| `pinch search` | 只查看远端 provider 的可用模型 |
| `pinch list` | 查看本地配置中的模型和当前默认模型 |
| `pinch test` | 测试某个模型是否可用 |
| `pinch default` | 切换默认模型 |
| `pinch del` | 删除模型配置 |
| `pinch backup` | 管理当前配置文件的备份 |

## 命令说明

### `pinch add`

手动添加模型。

```bash
pinch add <base_url> <api_key> <模型名称> <模型别名>
pinch add
```

如果参数不完整，会自动进入交互模式。

示例：

```bash
pinch add https://api.example.com/v1 sk-xxxx gpt-4.1 gpt41
```

### `pinch add --discover`

复用已存在的 provider 凭证，请求 `<base_url>/models` 搜索远端可用模型并写入配置。

```bash
pinch add --discover <base_url> <模型名称> <模型别名>
pinch add --discover
```

说明：

- `base_url` 必须已经存在于当前配置中
- 不传模型名称时，会先列出远端可用模型，再交互选择
- 不传别名时，会默认使用模型名称作为别名

### `pinch search`

只搜索远端 provider 上有哪些模型，不写入配置。

```bash
pinch search <base_url>
pinch search
```

适合先查看可用模型，再决定是否 `add --discover`。

### `pinch list`

聚合显示当前配置里的模型，并标记默认模型。

显示内容包含：

- 当前默认模型
- 是否为默认模型
- 模型别名
- 模型引用 `providerId/modelId`
- 模型名称
- `baseUrl`

`list` 会从这些位置聚合模型信息：

- `models.providers`
- `agents.defaults.models`
- `agents.defaults.model`
- `agents.list[*].model`

### `pinch test`

测试某个已添加模型是否可用。

```bash
pinch test <模型别名或模型引用>
pinch test <模型别名或模型引用> [测试提示词]
pinch test
```

说明：

- 支持传模型别名，例如 `gpt41`
- 也支持直接传 `modelRef`，例如 `provider-a/gpt-4.1`
- 会向对应 provider 的 `<base_url>/chat/completions` 发送一次最小请求
- 成功时会输出响应摘要，方便快速判断模型是否在线

示例：

```bash
pinch test gpt41
pinch test provider-a/gpt-4.1 "Reply with OK only."
```

### `pinch default`

切换当前默认模型，也就是更新 `agents.defaults.model.primary`。

兼容常见手误：`pinch dafault <模型别名或模型引用>` 也会按 `default` 处理。

```bash
pinch default <模型别名或模型引用>
pinch default
```

示例：

```bash
pinch default gpt41
pinch default provider-a/gpt-4.1
```

### `pinch del`

删除模型配置。

```bash
pinch del <模型别名或模型引用>
pinch del
pinch del --force <模型别名或模型引用>
```

说明：

- 默认会检查模型是否仍被 `agents.defaults.model` 或 `agents.list[*].model` 引用
- 如果模型仍在使用中，会拒绝删除
- 可通过 `--force` 强制删除

### `pinch backup`

管理当前配置文件对应的备份文件，默认目标仍是 `~/.openclaw/openclaw.json`，也支持配合 `--config` 使用。

```bash
pinch backup
pinch backup list
pinch backup show <备份时间戳|备份文件名|备份路径>
pinch backup add
pinch backup restore <备份时间戳|备份文件名|备份路径>
```

说明：

- `pinch backup` 与 `pinch backup list` 等价，会列出当前配置文件对应的所有备份
- `show` 支持传 14 位备份时间戳、完整备份文件名、或完整/相对路径
- `add` 会手动创建一份新备份，但不会修改当前配置内容
- `restore` 会先校验备份 JSON，再覆盖当前配置文件
- 如果当前配置文件存在，`restore` 之前会先自动再备份一次现场配置，避免误覆盖

## 推荐工作流

### 工作流一：新增一个 provider 并启用模型

```bash
pinch add https://api.example.com/v1 sk-xxxx gpt-4.1 gpt41
pinch test gpt41
pinch default gpt41
pinch list
```

### 工作流二：从已有 provider 中挑选一个远端模型启用

```bash
pinch search https://api.example.com/v1
pinch add --discover https://api.example.com/v1 gpt-4.1-mini gpt41mini
pinch test gpt41mini
pinch default gpt41mini
```

### 工作流三：安全删除旧模型

```bash
pinch list
pinch del gpt41
pinch del --force gpt41
```

## 安全与演练

支持 `--dry-run` 演练修改，不真正写文件：

```bash
pinch --dry-run add https://api.example.com/v1 sk-xxxx gpt-4.1 gpt41
pinch --dry-run default gpt41
pinch --dry-run del gpt41
pinch --dry-run backup add
pinch --dry-run backup restore 20260307123456
```

每次真正写入配置前，都会自动生成备份文件，例如：

```text
~/.openclaw/openclaw.json.bak.20260307123456
```

也可以通过 `pinch backup list` 查看所有备份，并用 `pinch backup show` / `pinch backup restore` 做内容检查或回滚。

## 配置文件说明

`pinch` 主要会维护这些位置：

- `models.providers`
- `agents.defaults.models`
- `agents.defaults.model.primary`
- `meta.lastTouchedAt`

## 常见问题

### 为什么 `add --discover` 或 `search` 失败？

通常是以下原因之一：

- `base_url` 对应的 provider 还没有录入到配置里
- 当前 provider 的 `apiKey` 无效
- 远端服务没有实现兼容的 `/models` 接口
- Node.js 版本过低，当前运行环境不支持所需的 `fetch`

### 为什么 `del` 提示模型仍在使用？

因为该模型仍被默认模型或某个 Agent 引用。你可以先切换默认模型，或者确认风险后使用：

```bash
pinch del --force <模型别名或模型引用>
```

### 为什么 `list` 里有些模型没有别名？

因为 `pinch list` 会从 provider 和引用关系聚合模型，不要求每个模型都已经配置 alias。这样可以避免“模型实际存在，但列表里看不到”的情况。

## 本地开发

```bash
npm run test:smoke
node bin/pinch.js --help
```

## License

`UNLICENSED`
