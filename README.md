# openclaw-model-cli

一个零依赖 Node CLI，用来管理 `~/.openclaw/openclaw.json` 里的第三方 OpenAI 兼容模型。

## 功能

- `add`：仅需输入 `base_url`、`api_key`、`模型名称`、`模型别名`
- `list`：列出当前已登记且带别名模型的别名、模型引用、名称和 `baseUrl`
- `del <模型别名>`：按别名删除模型配置；若模型正在被默认模型或某个 Agent 使用，会拒绝删除
- 自动复用已有 provider，或按 `base_url` 自动生成新的 provider id
- 自动在写入前备份原始配置文件
- 自动维护 `models.providers` 和 `agents.defaults.models`

## 使用

```bash
node bin/openclaw-model.js add https://api.example.com/v1 sk-xxxx gpt-4.1 gpt41
node bin/openclaw-model.js list
node bin/openclaw-model.js del gpt41
node bin/openclaw-model.js del --force gpt41
```

也支持交互输入：

```bash
node bin/openclaw-model.js add
node bin/openclaw-model.js del
```

安装为全局命令：

```bash
npm install -g .
openclaw-model add
openclaw-model list
openclaw-model del gpt41
openclaw-model del --force gpt41
```

查看帮助：

```bash
node bin/openclaw-model.js --help
```

## 备注

- 默认配置文件路径是 `~/.openclaw/openclaw.json`
- 可用 `--config /path/to/openclaw.json` 指定其他配置文件
- 可用 `--dry-run` 演练 `add` 或 `del`，不真正写入文件
- 当模型仍被 `agents.defaults.model` 或 `agents.list[*].model` 引用时，`del` 会阻止删除；可用 `--force` 覆盖
- `list` 只读取配置，不会改文件
