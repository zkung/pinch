#!/usr/bin/env node

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');

const DEFAULT_CONFIG_PATH = '~/.openclaw/openclaw.json';
const DEFAULT_MODEL_TEMPLATE = {
  reasoning: false,
  input: ['text'],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 128000,
  maxTokens: 8192,
};
const SUPPORTED_COMMANDS = new Set(['add', 'list', 'del']);

async function main() {
  try {
    const parsed = parseArgs(process.argv.slice(2));

    if (parsed.help) {
      printHelp();
      return;
    }

    const configPath = resolveHome(parsed.configPath || DEFAULT_CONFIG_PATH);
    const config = await loadJson(configPath);

    if (parsed.command === 'list') {
      const entries = listModelsFromConfig(config);
      printModelList(entries);
      return;
    }

    if (parsed.command === 'del') {
      const alias = await collectDeleteAlias(parsed);
      const result = deleteModelFromConfig(config, alias, { force: parsed.force });

      if (parsed.dryRun) {
        console.log('Dry run only. No files were changed.');
        printDeleteSummary(result, configPath, null);
        return;
      }

      const backupPath = await saveConfig(configPath, result.config);
      printDeleteSummary(result, configPath, backupPath);
      return;
    }

    const answers = await collectAddAnswers(parsed);
    const result = addModelToConfig(config, answers);

    if (parsed.dryRun) {
      console.log('Dry run only. No files were changed.');
      printAddSummary(result, configPath, null);
      return;
    }

    const backupPath = await saveConfig(configPath, result.config);
    printAddSummary(result, configPath, backupPath);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const options = {
    command: 'add',
    positionals: [],
    dryRun: false,
    force: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === '--help' || value === '-h') {
      options.help = true;
      continue;
    }

    if (value === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (value === '--force') {
      options.force = true;
      continue;
    }

    if (value === '--config') {
      const nextValue = argv[index + 1];
      if (!nextValue) {
        throw new Error('Missing value for --config');
      }
      options.configPath = nextValue;
      index += 1;
      continue;
    }

    if (value.startsWith('--config=')) {
      options.configPath = value.slice('--config='.length);
      continue;
    }

    if (SUPPORTED_COMMANDS.has(value) && options.command === 'add' && options.positionals.length === 0) {
      options.command = value;
      continue;
    }

    options.positionals.push(value);
  }

  return options;
}

async function collectAddAnswers(parsed) {
  const [baseUrlArg, apiKeyArg, modelNameArg, modelAliasArg] = parsed.positionals;
  const questions = [
    ['baseUrl', 'Base URL', baseUrlArg],
    ['apiKey', 'API Key', apiKeyArg],
    ['modelName', '模型名称', modelNameArg],
    ['modelAlias', '模型别名', modelAliasArg],
  ];

  const missing = questions.filter(([, , currentValue]) => !currentValue);
  if (missing.length === 0) {
    return normalizeAddAnswers({
      baseUrl: baseUrlArg,
      apiKey: apiKeyArg,
      modelName: modelNameArg,
      modelAlias: modelAliasArg,
    });
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    const answers = {
      baseUrl: baseUrlArg,
      apiKey: apiKeyArg,
      modelName: modelNameArg,
      modelAlias: modelAliasArg,
    };

    for (const [field, label, currentValue] of questions) {
      if (currentValue) {
        continue;
      }

      const answer = await rl.question(`${label}: `);
      answers[field] = answer;
    }

    return normalizeAddAnswers(answers);
  } finally {
    rl.close();
  }
}

async function collectDeleteAlias(parsed) {
  const [aliasArg] = parsed.positionals;
  if (aliasArg) {
    return normalizeAlias(aliasArg);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const alias = await rl.question('模型别名: ');
    return normalizeAlias(alias);
  } finally {
    rl.close();
  }
}

function normalizeAddAnswers(answers) {
  const baseUrl = normalizeBaseUrl(answers.baseUrl);
  const apiKey = String(answers.apiKey || '').trim();
  const modelName = String(answers.modelName || '').trim();
  const modelAlias = normalizeAlias(answers.modelAlias);

  if (!baseUrl) {
    throw new Error('Base URL is required');
  }
  if (!apiKey) {
    throw new Error('API Key is required');
  }
  if (!modelName) {
    throw new Error('模型名称不能为空');
  }

  return { baseUrl, apiKey, modelName, modelAlias };
}

function normalizeAlias(value) {
  const alias = String(value || '').trim();
  if (!alias) {
    throw new Error('模型别名不能为空');
  }
  return alias;
}

function normalizeBaseUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid Base URL: ${trimmed}`);
  }

  const pathname = parsed.pathname.replace(/\/$/, '');
  parsed.pathname = pathname || '/';
  return parsed.toString().replace(/\/$/, '');
}

async function loadJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse JSON at ${filePath}: ${error.message}`);
  }
}

async function saveConfig(filePath, config) {
  const backupPath = await writeBackup(filePath);
  await fs.writeFile(filePath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return backupPath;
}

function addModelToConfig(config, answers) {
  ensureConfigContainers(config);

  const existingProviderId = findProviderId(config.models.providers, answers.baseUrl, answers.apiKey);
  const providerId = existingProviderId || createProviderId(config.models.providers, answers.baseUrl);
  const provider = config.models.providers[providerId] || createProvider(answers.baseUrl, answers.apiKey);

  provider.baseUrl = answers.baseUrl;
  provider.apiKey = answers.apiKey;
  provider.api = provider.api || 'openai-completions';
  provider.models = Array.isArray(provider.models) ? provider.models : [];

  const modelId = answers.modelName;
  const modelRef = `${providerId}/${modelId}`;

  ensureAliasIsAvailable(config.agents.defaults.models, modelRef, answers.modelAlias);

  const existingModel = provider.models.find((model) => model && model.id === modelId);
  if (existingModel) {
    existingModel.name = answers.modelName;
    existingModel.reasoning = existingModel.reasoning ?? DEFAULT_MODEL_TEMPLATE.reasoning;
    existingModel.input = Array.isArray(existingModel.input) ? existingModel.input : [...DEFAULT_MODEL_TEMPLATE.input];
    existingModel.cost = existingModel.cost || { ...DEFAULT_MODEL_TEMPLATE.cost };
    existingModel.contextWindow = existingModel.contextWindow || DEFAULT_MODEL_TEMPLATE.contextWindow;
    existingModel.maxTokens = existingModel.maxTokens || DEFAULT_MODEL_TEMPLATE.maxTokens;
  } else {
    provider.models.push({
      id: modelId,
      name: answers.modelName,
      reasoning: DEFAULT_MODEL_TEMPLATE.reasoning,
      input: [...DEFAULT_MODEL_TEMPLATE.input],
      cost: { ...DEFAULT_MODEL_TEMPLATE.cost },
      contextWindow: DEFAULT_MODEL_TEMPLATE.contextWindow,
      maxTokens: DEFAULT_MODEL_TEMPLATE.maxTokens,
    });
  }

  config.models.providers[providerId] = provider;
  config.agents.defaults.models[modelRef] = {
    ...(config.agents.defaults.models[modelRef] || {}),
    alias: answers.modelAlias,
  };

  touchMeta(config);

  return {
    config,
    providerId,
    modelId,
    modelRef,
    alias: answers.modelAlias,
    providerCreated: !existingProviderId,
    modelCreated: !existingModel,
  };
}

function listModelsFromConfig(config) {
  const modelEntries = Object.entries(config?.agents?.defaults?.models || {})
    .filter(([, settings]) => settings && settings.alias);

  return modelEntries
    .map(([modelRef, settings]) => {
      const [providerId, modelId] = splitModelRef(modelRef);
      const provider = config?.models?.providers?.[providerId];
      const providerModels = Array.isArray(provider?.models) ? provider.models : [];
      const model = providerModels.find((entry) => entry && entry.id === modelId);

      return {
        alias: settings?.alias || '',
        modelRef,
        modelName: model?.name || modelId,
        providerId,
        baseUrl: provider?.baseUrl || '',
      };
    })
    .sort((left, right) => {
      const aliasOrder = (left.alias || '~').localeCompare(right.alias || '~');
      if (aliasOrder !== 0) {
        return aliasOrder;
      }
      return left.modelRef.localeCompare(right.modelRef);
    });
}

function deleteModelFromConfig(config, alias, options = {}) {
  ensureConfigContainers(config);

  const matches = Object.entries(config.agents.defaults.models)
    .filter(([, settings]) => settings && settings.alias === alias)
    .map(([modelRef]) => modelRef);

  if (matches.length === 0) {
    throw new Error(`未找到别名为 ${alias} 的模型`);
  }

  if (matches.length > 1) {
    throw new Error(`别名 ${alias} 匹配到多个模型：${matches.join(', ')}`);
  }

  const [modelRef] = matches;
  const usages = findModelUsages(config, modelRef);
  if (usages.length > 0 && !options.force) {
    throw new Error(`模型别名 ${alias} 当前正在被使用：${usages.join(', ')}。请先切换默认模型或 Agent 模型，或使用 --force 强制删除`);
  }

  const [providerId, modelId] = splitModelRef(modelRef);
  const provider = config.models.providers[providerId];

  let modelRemoved = false;
  let providerRemoved = false;

  if (provider && Array.isArray(provider.models)) {
    const nextModels = provider.models.filter((model) => !model || model.id !== modelId);
    modelRemoved = nextModels.length !== provider.models.length;
    provider.models = nextModels;

    if (provider.models.length === 0) {
      delete config.models.providers[providerId];
      providerRemoved = true;
    }
  }

  delete config.agents.defaults.models[modelRef];
  touchMeta(config);

  return {
    config,
    alias,
    modelRef,
    providerId,
    modelRemoved,
    providerRemoved,
    usages,
    forced: Boolean(options.force && usages.length > 0),
  };
}

function findModelUsages(config, modelRef) {
  const usages = [];
  const defaultsModel = config?.agents?.defaults?.model;

  if (defaultsModel?.primary === modelRef) {
    usages.push('agents.defaults.model.primary');
  }

  const defaultFallbacks = Array.isArray(defaultsModel?.fallbacks) ? defaultsModel.fallbacks : [];
  defaultFallbacks.forEach((fallback, index) => {
    if (fallback === modelRef) {
      usages.push(`agents.defaults.model.fallbacks[${index}]`);
    }
  });

  const agentList = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  agentList.forEach((agent, index) => {
    const agentPrefix = agent && agent.id ? `agents.list[id=${agent.id}]` : `agents.list[${index}]`;

    if (agent?.model?.primary === modelRef) {
      usages.push(`${agentPrefix}.model.primary`);
    }

    const agentFallbacks = Array.isArray(agent?.model?.fallbacks) ? agent.model.fallbacks : [];
    agentFallbacks.forEach((fallback, fallbackIndex) => {
      if (fallback === modelRef) {
        usages.push(`${agentPrefix}.model.fallbacks[${fallbackIndex}]`);
      }
    });
  });

  return usages;
}

function ensureConfigContainers(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('Config file content must be a JSON object');
  }

  config.models = config.models || {};
  config.models.mode = config.models.mode || 'merge';
  config.models.providers = config.models.providers || {};

  config.agents = config.agents || {};
  config.agents.defaults = config.agents.defaults || {};
  config.agents.defaults.models = config.agents.defaults.models || {};
}

function touchMeta(config) {
  config.meta = config.meta || {};
  config.meta.lastTouchedAt = new Date().toISOString();
}

function splitModelRef(modelRef) {
  const separatorIndex = String(modelRef).indexOf('/');
  if (separatorIndex === -1) {
    return [String(modelRef), ''];
  }

  return [
    modelRef.slice(0, separatorIndex),
    modelRef.slice(separatorIndex + 1),
  ];
}

function createProvider(baseUrl, apiKey) {
  return {
    baseUrl,
    apiKey,
    api: 'openai-completions',
    models: [],
  };
}

function findProviderId(providers, baseUrl, apiKey) {
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== 'object') {
      continue;
    }

    if (normalizeComparableUrl(provider.baseUrl) === normalizeComparableUrl(baseUrl) && String(provider.apiKey || '') === apiKey) {
      return providerId;
    }
  }

  return '';
}

function normalizeComparableUrl(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function createProviderId(providers, baseUrl) {
  let candidate = 'provider';

  try {
    const parsed = new URL(baseUrl);
    const source = `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
    candidate = slugify(source) || candidate;
  } catch {
    candidate = slugify(baseUrl) || candidate;
  }

  let uniqueCandidate = candidate;
  let counter = 2;
  while (Object.prototype.hasOwnProperty.call(providers, uniqueCandidate)) {
    uniqueCandidate = `${candidate}-${counter}`;
    counter += 1;
  }
  return uniqueCandidate;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function ensureAliasIsAvailable(modelMap, targetRef, alias) {
  for (const [modelRef, settings] of Object.entries(modelMap)) {
    if (modelRef === targetRef) {
      continue;
    }

    if (settings && settings.alias === alias) {
      throw new Error(`模型别名 ${alias} 已被 ${modelRef} 使用，请换一个别名`);
    }
  }
}

async function writeBackup(filePath) {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const backupPath = `${filePath}.bak.${timestamp}`;
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

function resolveHome(targetPath) {
  if (!targetPath.startsWith('~/')) {
    return path.resolve(targetPath);
  }

  return path.join(os.homedir(), targetPath.slice(2));
}

function printAddSummary(result, configPath, backupPath) {
  const providerMessage = result.providerCreated ? 'created' : 'reused';
  const modelMessage = result.modelCreated ? 'added' : 'updated';

  console.log(`Provider ${providerMessage}: ${result.providerId}`);
  console.log(`Model ${modelMessage}: ${result.modelRef}`);
  console.log(`Alias set: ${result.alias}`);
  console.log(`Config path: ${configPath}`);

  if (backupPath) {
    console.log(`Backup path: ${backupPath}`);
  }
}

function printDeleteSummary(result, configPath, backupPath) {
  console.log(`Alias removed: ${result.alias}`);
  console.log(`Model removed: ${result.modelRef}`);
  console.log(`Provider removed: ${result.providerRemoved ? result.providerId : 'no'}`);
  console.log(`Forced delete: ${result.forced ? 'yes' : 'no'}`);

  if (result.usages.length > 0) {
    console.log(`Usages bypassed: ${result.usages.join(', ')}`);
  }

  console.log(`Config path: ${configPath}`);

  if (backupPath) {
    console.log(`Backup path: ${backupPath}`);
  }
}

function printModelList(entries) {
  if (entries.length === 0) {
    console.log('No configured models found.');
    return;
  }

  const columns = [
    ['alias', 'ALIAS'],
    ['modelRef', 'MODEL'],
    ['modelName', 'NAME'],
    ['baseUrl', 'BASE_URL'],
  ];

  const rows = entries.map((entry) => ({
    alias: entry.alias || '-',
    modelRef: entry.modelRef || '-',
    modelName: entry.modelName || '-',
    baseUrl: entry.baseUrl || '-',
  }));

  const widths = columns.map(([key, title]) => {
    const rowWidths = rows.map((row) => getDisplayWidth(row[key]));
    return Math.max(getDisplayWidth(title), ...rowWidths);
  });

  const formatRow = (row) => columns
    .map(([key], index) => padDisplay(row[key], widths[index]))
    .join('  ')
    .replace(/\s+$/, '');

  console.log(formatRow({
    alias: 'ALIAS',
    modelRef: 'MODEL',
    modelName: 'NAME',
    baseUrl: 'BASE_URL',
  }));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));

  for (const row of rows) {
    console.log(formatRow(row));
  }
}

function getDisplayWidth(value) {
  return Array.from(String(value || '')).reduce((width, char) => {
    return width + (char.codePointAt(0) > 0xFF ? 2 : 1);
  }, 0);
}

function padDisplay(value, targetWidth) {
  const text = String(value || '');
  const padding = Math.max(targetWidth - getDisplayWidth(text), 0);
  return text + ' '.repeat(padding);
}

function printHelp() {
  console.log(`openclaw-model

为 OpenClaw 的 ~/.openclaw/openclaw.json 管理第三方模型。

用法:
  openclaw-model add <base_url> <api_key> <模型名称> <模型别名>
  openclaw-model add
  openclaw-model list
  openclaw-model del <模型别名>
  openclaw-model del
  openclaw-model del --force <模型别名>
  openclaw-model --config /path/to/openclaw.json --dry-run add
  openclaw-model --config /path/to/openclaw.json --dry-run del <模型别名>

示例:
  openclaw-model add https://api.example.com/v1 sk-xxxx gpt-4.1 gpt41
  openclaw-model list
  openclaw-model del gpt41
  openclaw-model del --force gpt41

说明:
  - add 仅需输入 base_url、api_key、模型名称、模型别名
  - list 会列出 agents.defaults.models 中已登记且带别名的模型
  - del 会按模型别名删除 models.providers 和 agents.defaults.models 中对应条目
  - 若模型正被 agents.defaults.model 或 agents.list[*].model 使用，del 会拒绝删除；可用 --force 覆盖
  - 若同一个 base_url + api_key 已存在，会复用现有 provider
  - 若 provider 不存在，会自动生成 provider id
  - 写入前会自动备份 openclaw.json`);
}

main();
