# pinch

一个零依赖的 Node CLI，用来管理 `~/.openclaw/openclaw.json` 里的第三方 OpenAI 兼容模型。

`pinch` 适合这些场景：

- 快速把新的 OpenAI 兼容模型注册到 OpenClaw
- 复用已有 provider，自动发现远端可用模型
- 测试某个已添加模型是否还能正常响应
- 切换当前默认模型，不手改 JSON
- 删除模型前检查引用关系，避免误删

## 特性

- 零依赖，直接基于 Node 运行
- 自动复用已有 provider，或按 `base_url` 生成新的 provider id
- 支持通过远端 `/models` 自动发现模型并添加
- 支持按别名或 `modelRef` 测试模型可用性
- 支持按别名或 `modelRef` 切换默认模型
- 删除前自动检查 `agents.defaults.model` 和 `agents.list[*].model` 的引用
- 写入前自动备份原始配置文件
- `list` 会聚合显示 provider 中的模型，并标记当前默认模型

## 安装

发布到 npm 后：

```bash
npm install -g pinch
```

本地开发或本地安装：

```bash
npm install -g .
```

也可以直接在仓库里运行：

```bash
node bin/pinch.js --help
```

## 使用前提

- 需要 Node.js 18 或更高版本
- 默认配置文件路径是 `~/.openclaw/openclaw.json`
- 如需操作其他配置文件，可使用 `--config /path/to/openclaw.json`

## 快速开始

### 1. 手动添加一个模型

```bash
pinch add https://api.example.com/v1 sk-xxxx gpt-4.1 gpt41
```

### 2. 从已有 provider 自动发现模型并添加

```bash
pinch add --discover https://api.example.com/v1 gpt-4.1 gpt41
```

### 3. 查看当前模型列表和默认模型

```bash
pinch list
```

### 4. 测试某个模型是否可用

```bash
pinch test gpt41
pinch test provider-a/gpt-4.1
```

### 5. 切换默认模型

```bash
pinch default gpt41
pinch default provider-a/gpt-4.1
```

### 6. 删除模型

```bash
pinch del gpt41
pinch del provider-a/gpt-4.1
pinch del --force gpt41
```

## 命令总览

### `pinch add`

手动添加模型。

```bash
pinch add <base_url> <api_key> <模型名称> <模型别名>
```

如果参数不完整，会自动进入交互输入。

示例：

```bash
pinch add https://api.example.com/v1 sk-xxxx gpt-4.1 gpt41
pinch add
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
- 不传别名时，会默认使用模型名作为别名

### `pinch search`

只搜索远端 provider 上有哪些模型，不写配置。

```bash
pinch search <base_url>
pinch search
```

### `pinch list`

聚合显示当前配置里的模型，并标记默认模型。

输出内容包含：

- 当前默认模型
- 是否为默认模型
- 模型别名
- 模型引用 `providerId/modelId`
- 模型名称
- `baseUrl`

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

## 典型工作流

### 工作流一：新增一个 provider + 模型

```bash
pinch add https://api.example.com/v1 sk-xxxx gpt-4.1 gpt41
pinch list
pinch test gpt41
pinch default gpt41
```

### 工作流二：从已有 provider 中挑一个模型启用

```bash
pinch search https://api.example.com/v1
pinch add --discover https://api.example.com/v1 gpt-4.1-mini gpt41mini
pinch test gpt41mini
pinch default gpt41mini
```

### 工作流三：安全删除一个旧模型

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
```

每次真正写入配置前，都会自动生成备份文件，例如：

```bash
~/.openclaw/openclaw.json.bak.20260307123456
```

## 配置文件说明

`pinch` 主要会维护这些位置：

- `models.providers`
- `agents.defaults.models`
- `agents.defaults.model.primary`
- `meta.lastTouchedAt`

`list` 读取时会从以下位置聚合模型信息：

- `models.providers`
- `agents.defaults.models`
- `agents.defaults.model`
- `agents.list[*].model`

## 常见问题

### 为什么 `add --discover` / `search` 失败？

通常是以下原因之一：

- `base_url` 对应的 provider 还没有录入到配置里
- 当前 provider 的 `apiKey` 无效
- 远端服务没有实现兼容的 `/models` 接口
- Node 版本过低，不支持当前运行所需的 `fetch`

### 为什么 `del` 提示模型仍在使用？

因为该模型还被默认模型或某个 Agent 引用。你可以先切换默认模型，或者确认风险后使用：

```bash
pinch del --force <模型别名或模型引用>
```

## 本地开发

```bash
npm run test:smoke
node bin/pinch.js --help
```

## License

`UNLICENSED`
