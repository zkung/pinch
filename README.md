# openclaw-model-cli

一个零依赖 Node CLI，用来管理 `~/.openclaw/openclaw.json` 里的第三方 OpenAI 兼容模型。

## 功能

- `add`：仅需输入 `base_url`、`api_key`、`模型名称`、`模型别名`
- `add --discover`：复用已存在的 `base_url` + `api_key`，调用远端 `/models` 搜索可用模型并添加
- `search`：通过已有 `base_url` 搜索远端 provider 的可用模型，但不写入配置
- `test`：测试指定已添加模型是否可用，支持传模型别名或 `modelRef`
- `default`：按模型别名或 `modelRef` 切换当前默认模型
- `list`：聚合列出当前 provider 中的模型，并显示别名、模型引用、名称、`baseUrl` 以及当前默认模型
- `del <模型别名>`：按别名删除模型配置；若模型正在被默认模型或某个 Agent 使用，会拒绝删除
- 自动复用已有 provider，或按 `base_url` 自动生成新的 provider id
- 自动在写入前备份原始配置文件
- 自动维护 `models.providers` 和 `agents.defaults.models`

## 使用

```bash
node bin/openclaw-model.js add https://api.example.com/v1 sk-xxxx gpt-4.1 gpt41
node bin/openclaw-model.js add --discover https://api.example.com/v1 gpt-4.1 gpt41
node bin/openclaw-model.js search https://api.example.com/v1
node bin/openclaw-model.js test gpt41
node bin/openclaw-model.js test provider-a/gpt-4.1
node bin/openclaw-model.js default gpt41
node bin/openclaw-model.js default provider-a/gpt-4.1
node bin/openclaw-model.js list
node bin/openclaw-model.js del gpt41
node bin/openclaw-model.js del provider-a/gpt-4.1
node bin/openclaw-model.js del --force gpt41
```

也支持交互输入：

```bash
node bin/openclaw-model.js add
node bin/openclaw-model.js add --discover
node bin/openclaw-model.js search
node bin/openclaw-model.js test
node bin/openclaw-model.js default
node bin/openclaw-model.js del
```

安装为全局命令：

```bash
npm install -g .
openclaw-model add
openclaw-model add --discover
openclaw-model search
openclaw-model test gpt41
openclaw-model test provider-a/gpt-4.1
openclaw-model default gpt41
openclaw-model default provider-a/gpt-4.1
openclaw-model list
openclaw-model del gpt41
openclaw-model del provider-a/gpt-4.1
openclaw-model del --force gpt41
```

查看帮助：

```bash
node bin/openclaw-model.js --help
```

## 备注

- 默认配置文件路径是 `~/.openclaw/openclaw.json`
- 可用 `--config /path/to/openclaw.json` 指定其他配置文件
- 可用 `--dry-run` 演练 `add`、`default` 或 `del`，不真正写入文件
- `add --discover <base_url> <模型名称> <模型别名>` 会从已保存的 provider 凭证请求 `<base_url>/models`，确认模型存在后再写入配置
- `add --discover` 不传模型名时，会先列出远端可用模型，再交互选择并填写别名
- `search <base_url>` 会从已保存的 provider 凭证请求 `<base_url>/models`，只打印远端可用模型
- `test <模型别名或模型引用> [测试提示词]` 会根据 alias 或 `providerId/modelId` 找到 provider 和模型，并调用 `<base_url>/chat/completions` 做一次最小可用性验证
- `default <模型别名或模型引用>` 会把 `agents.defaults.model.primary` 切换到指定模型
- 当模型仍被 `agents.defaults.model` 或 `agents.list[*].model` 引用时，`del` 会阻止删除；可用 `--force` 覆盖
- `list` 会从 `models.providers`、`agents.defaults.models` 和当前引用关系聚合模型，并标记默认项
