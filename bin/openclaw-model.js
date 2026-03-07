#!/usr/bin/env node

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');

const DEFAULT_CONFIG_PATH = '~/.openclaw/openclaw.json';
const DISCOVER_REQUEST_TIMEOUT_MS = 15000;
const MODEL_TEST_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_TEST_PROMPT = 'Please reply with OK only.';
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
const SUPPORTED_COMMANDS = new Set(['add', 'list', 'del', 'search', 'test', 'default']);

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
      const listResult = listModelsFromConfig(config);
      printModelList(listResult);
      return;
    }

    if (parsed.command === 'search') {
      const result = await collectSearchResults(parsed, config);
      printAvailableModels(result.models, result.providerId, result.provider.baseUrl);
      return;
    }

    if (parsed.command === 'test') {
      const testInput = await collectTestInput(parsed);
      const result = await testConfiguredModel(config, testInput.selector, testInput.prompt);
      printTestSummary(result);
      return;
    }

    if (parsed.command === 'default') {
      const alias = await collectDefaultAlias(parsed);
      const result = setDefaultModelInConfig(config, alias);

      if (parsed.dryRun) {
        console.log('Dry run only. No files were changed.');
        printDefaultSummary(result, configPath, null);
        return;
      }

      if (!result.changed) {
        printDefaultSummary(result, configPath, null);
        return;
      }

      const backupPath = await saveConfig(configPath, result.config);
      printDefaultSummary(result, configPath, backupPath);
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

    const answers = parsed.discover
      ? await collectDiscoveredAddAnswers(parsed, config)
      : await collectAddAnswers(parsed);
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
    discover: false,
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

    if (value === '--discover') {
      options.discover = true;
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

async function collectDiscoveredAddAnswers(parsed, config) {
  const [baseUrlArg, modelNameArg, modelAliasArg] = parsed.positionals;
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    const rawBaseUrl = baseUrlArg || await rl.question('Base URL: ');
    const baseUrl = normalizeBaseUrl(rawBaseUrl);
    const discovery = await discoverModelsForBaseUrl(config, baseUrl, rl);
    const { providerMatch, discoveredModels } = discovery;

    const providedModelName = String(modelNameArg || '').trim();
    let selectedModel = null;

    if (providedModelName) {
      selectedModel = discoveredModels.find((model) => model.id === providedModelName) || null;
      if (!selectedModel) {
        throw new Error(`在 ${providerMatch.provider.baseUrl} 上未找到模型 ${providedModelName}`);
      }
    } else {
      printAvailableModels(discoveredModels, providerMatch.providerId);
      selectedModel = await promptForModelSelection(discoveredModels, rl);
    }

    const suggestedAlias = selectedModel.id;
    const aliasAnswer = modelAliasArg || await rl.question(`模型别名 [${suggestedAlias}]: `);
    const modelAlias = String(aliasAnswer || '').trim() || suggestedAlias;

    return normalizeAddAnswers({
      baseUrl: providerMatch.provider.baseUrl,
      apiKey: providerMatch.provider.apiKey,
      modelName: selectedModel.id,
      modelAlias,
    });
  } finally {
    rl.close();
  }
}

async function collectSearchResults(parsed, config) {
  const [baseUrlArg] = parsed.positionals;
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    const rawBaseUrl = baseUrlArg || await rl.question('Base URL: ');
    const baseUrl = normalizeBaseUrl(rawBaseUrl);
    const discovery = await discoverModelsForBaseUrl(config, baseUrl, rl);

    return {
      providerId: discovery.providerMatch.providerId,
      provider: discovery.providerMatch.provider,
      models: discovery.discoveredModels,
    };
  } finally {
    rl.close();
  }
}

async function collectTestInput(parsed) {
  const [selectorArg, ...promptParts] = parsed.positionals;
  const promptArg = promptParts.join(' ').trim();

  if (selectorArg) {
    return {
      selector: normalizeModelSelector(selectorArg),
      prompt: promptArg || DEFAULT_TEST_PROMPT,
    };
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const selector = await rl.question('模型别名或模型引用: ');
    return {
      selector: normalizeModelSelector(selector),
      prompt: DEFAULT_TEST_PROMPT,
    };
  } finally {
    rl.close();
  }
}

async function collectDefaultAlias(parsed) {
  const [selectorArg] = parsed.positionals;
  if (selectorArg) {
    return normalizeModelSelector(selectorArg);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const selector = await rl.question('默认模型别名或模型引用: ');
    return normalizeModelSelector(selector);
  } finally {
    rl.close();
  }
}

async function collectDeleteAlias(parsed) {
  const [selectorArg] = parsed.positionals;
  if (selectorArg) {
    return normalizeModelSelector(selectorArg);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const selector = await rl.question('模型别名或模型引用: ');
    return normalizeModelSelector(selector);
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

function normalizeModelSelector(value) {
  const selector = String(value || '').trim();
  if (!selector) {
    throw new Error('模型标识不能为空');
  }
  return selector;
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

async function selectProviderForDiscovery(config, baseUrl, rl) {
  ensureConfigContainers(config);

  const matches = findProvidersByBaseUrl(config.models.providers, baseUrl);
  if (matches.length === 0) {
    throw new Error(`未找到 baseUrl 为 ${baseUrl} 的 provider，请先用 add 命令录入 API Key`);
  }

  if (matches.length === 1) {
    return matches[0];
  }

  if (!stdin.isTTY) {
    throw new Error(`baseUrl ${baseUrl} 匹配到多个 provider：${matches.map((match) => match.providerId).join(', ')}。请在交互终端中重试并选择 provider`);
  }

  console.log(`发现多个 provider 使用 ${baseUrl}：`);
  matches.forEach((match, index) => {
    console.log(`  ${index + 1}. ${match.providerId}`);
  });

  while (true) {
    const answer = String(await rl.question('请选择 provider 序号: ') || '').trim();
    const selectedIndex = Number(answer);

    if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= matches.length) {
      return matches[selectedIndex - 1];
    }

    const selectedById = matches.find((match) => match.providerId === answer);
    if (selectedById) {
      return selectedById;
    }

    console.log('输入无效，请重新输入序号或 provider id。');
  }
}

async function discoverModelsForBaseUrl(config, baseUrl, rl) {
  if (!baseUrl) {
    throw new Error('Base URL is required');
  }

  const providerMatch = await selectProviderForDiscovery(config, baseUrl, rl);
  const discoveredModels = await fetchAvailableModels(providerMatch.provider.baseUrl, providerMatch.provider.apiKey);

  if (discoveredModels.length === 0) {
    throw new Error(`在 ${providerMatch.provider.baseUrl} 上未发现可用模型`);
  }

  return { providerMatch, discoveredModels };
}

async function testConfiguredModel(config, selector, prompt) {
  const resolved = resolveConfiguredModel(config, selector);
  const endpointUrl = createChatCompletionsUrl(resolved.provider.baseUrl);
  const payload = await sendModelTestRequest(endpointUrl, resolved.provider.apiKey, resolved.modelId, prompt);
  const responsePreview = extractResponsePreview(payload);

  if (!Array.isArray(payload?.choices) && !responsePreview && typeof payload?.id !== 'string') {
    throw new Error(`接口 ${endpointUrl} 返回成功，但响应结构无法识别`);
  }

  return {
    alias: resolved.alias,
    modelRef: resolved.modelRef,
    providerId: resolved.providerId,
    baseUrl: resolved.provider.baseUrl || '',
    endpointUrl,
    prompt,
    responseId: typeof payload?.id === 'string' ? payload.id : '',
    responsePreview,
  };
}

function setDefaultModelInConfig(config, alias) {
  ensureConfigContainers(config);

  const resolved = resolveConfiguredModel(config, alias);
  config.agents.defaults.model = config.agents.defaults.model || {};
  config.agents.defaults.model.fallbacks = Array.isArray(config.agents.defaults.model.fallbacks)
    ? config.agents.defaults.model.fallbacks
    : [];

  const previousModelRef = String(config.agents.defaults.model.primary || '');
  const previousAlias = String(config.agents.defaults.models?.[previousModelRef]?.alias || '').trim();
  const changed = previousModelRef !== resolved.modelRef;

  if (changed) {
    config.agents.defaults.model.primary = resolved.modelRef;
    touchMeta(config);
  }

  return {
    config,
    alias: resolved.alias,
    modelRef: resolved.modelRef,
    providerId: resolved.providerId,
    previousModelRef,
    previousAlias,
    changed,
  };
}

function resolveConfiguredModel(config, selector) {
  ensureConfigContainers(config);
  const normalizedSelector = normalizeModelSelector(selector);

  const exactModelRef = resolveModelRefBySelector(config, normalizedSelector);
  if (!exactModelRef) {
    throw new Error(`未找到模型标识为 ${normalizedSelector} 的模型`);
  }

  return describeResolvedModel(config, exactModelRef);
}

function resolveModelRefBySelector(config, selector) {
  const normalizedSelector = normalizeModelSelector(selector);
  const availableModelRefs = new Set(collectConfiguredModelRefs(config));

  if (availableModelRefs.has(normalizedSelector)) {
    return normalizedSelector;
  }

  const matches = Object.entries(config.agents.defaults.models)
    .filter(([, settings]) => settings && settings.alias === normalizedSelector)
    .map(([modelRef]) => modelRef);

  if (matches.length === 0) {
    return '';
  }

  if (matches.length > 1) {
    throw new Error(`模型标识 ${normalizedSelector} 匹配到多个模型：${matches.join(', ')}`);
  }

  return matches[0];
}

function describeResolvedModel(config, modelRef) {
  const settings = config.agents.defaults.models?.[modelRef] || null;
  const [providerId, modelId] = splitModelRef(modelRef);
  const provider = config.models.providers[providerId];

  if (!provider || typeof provider !== 'object') {
    throw new Error(`模型 ${modelRef} 对应的 provider ${providerId} 不存在`);
  }

  return {
    alias: settings?.alias || '',
    modelRef,
    providerId,
    modelId,
    provider,
  };
}

function findProvidersByBaseUrl(providers, baseUrl) {
  const targetBaseUrl = normalizeComparableUrl(baseUrl);

  return Object.entries(providers)
    .filter(([, provider]) => provider && typeof provider === 'object')
    .filter(([, provider]) => normalizeComparableUrl(provider.baseUrl) === targetBaseUrl)
    .map(([providerId, provider]) => ({ providerId, provider }));
}

async function fetchAvailableModels(baseUrl, apiKey) {
  if (typeof fetch !== 'function') {
    throw new Error('当前 Node 版本不支持 fetch，无法发现远端模型');
  }

  const modelsUrl = createModelsUrl(baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCOVER_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(modelsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    const responseText = await response.text();
    const payload = parseJsonPayload(responseText, modelsUrl);

    if (!response.ok) {
      const errorMessage = payload?.error?.message || summarizeResponseText(responseText);
      throw new Error(`请求 ${modelsUrl} 失败：${response.status} ${response.statusText}${errorMessage ? ` - ${errorMessage}` : ''}`);
    }

    const discoveredModels = extractDiscoveredModels(payload);
    if (discoveredModels.length === 0) {
      throw new Error(`接口 ${modelsUrl} 返回成功，但没有可识别的模型列表`);
    }

    return discoveredModels;
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`请求 ${modelsUrl} 超时`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function createModelsUrl(baseUrl) {
  return createApiUrl(baseUrl, '/models');
}

function createChatCompletionsUrl(baseUrl) {
  return createApiUrl(baseUrl, '/chat/completions');
}

function createApiUrl(baseUrl, apiPath) {
  const parsed = new URL(baseUrl);
  const pathname = parsed.pathname.replace(/\/$/, '');
  parsed.pathname = `${pathname || ''}${apiPath}`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function parseJsonPayload(responseText, sourceUrl) {
  if (!responseText) {
    return null;
  }

  try {
    return JSON.parse(responseText);
  } catch {
    throw new Error(`接口 ${sourceUrl} 返回了非 JSON 内容：${summarizeResponseText(responseText)}`);
  }
}

async function sendModelTestRequest(endpointUrl, apiKey, modelId, prompt) {
  if (typeof fetch !== 'function') {
    throw new Error('当前 Node 版本不支持 fetch，无法测试模型可用性');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_TEST_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
      signal: controller.signal,
    });

    const responseText = await response.text();
    const payload = parseJsonPayload(responseText, endpointUrl);

    if (!response.ok) {
      const errorMessage = payload?.error?.message || summarizeResponseText(responseText);
      throw new Error(`请求 ${endpointUrl} 失败：${response.status} ${response.statusText}${errorMessage ? ` - ${errorMessage}` : ''}`);
    }

    return payload;
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`请求 ${endpointUrl} 超时`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function summarizeResponseText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function extractDiscoveredModels(payload) {
  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];

  const uniqueModels = new Map();

  entries.forEach((entry) => {
    const modelId = typeof entry === 'string'
      ? entry
      : typeof entry?.id === 'string'
        ? entry.id
        : typeof entry?.name === 'string'
          ? entry.name
          : '';

    if (!modelId || uniqueModels.has(modelId)) {
      return;
    }

    uniqueModels.set(modelId, {
      id: modelId,
      name: typeof entry?.name === 'string' ? entry.name : '',
      ownedBy: typeof entry?.owned_by === 'string' ? entry.owned_by : '',
    });
  });

  return Array.from(uniqueModels.values()).sort((left, right) => left.id.localeCompare(right.id));
}

function extractResponsePreview(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;

  return normalizeResponseText(choice?.message?.content)
    || normalizeResponseText(choice?.text)
    || normalizeResponseText(payload?.output_text)
    || normalizeResponseText(payload?.content)
    || '';
}

function normalizeResponseText(value) {
  if (typeof value === 'string') {
    return value.replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  if (Array.isArray(value)) {
    const text = value
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry;
        }
        if (typeof entry?.text === 'string') {
          return entry.text;
        }
        if (typeof entry?.content === 'string') {
          return entry.content;
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');

    return text.replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  return '';
}

function printAvailableModels(models, providerId, baseUrl) {
  console.log(`在 provider ${providerId} 上发现以下模型：`);
  if (baseUrl) {
    console.log(`Base URL: ${baseUrl}`);
  }
  models.forEach((model, index) => {
    const details = [];
    if (model.name && model.name !== model.id) {
      details.push(`name=${model.name}`);
    }
    if (model.ownedBy) {
      details.push(`owned_by=${model.ownedBy}`);
    }

    const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
    console.log(`  ${index + 1}. ${model.id}${suffix}`);
  });
}

async function promptForModelSelection(models, rl) {
  while (true) {
    const answer = String(await rl.question('模型名称或序号: ') || '').trim();
    const selectedIndex = Number(answer);

    if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= models.length) {
      return models[selectedIndex - 1];
    }

    const selectedById = models.find((model) => model.id === answer);
    if (selectedById) {
      return selectedById;
    }

    console.log('输入无效，请重新输入模型序号或完整模型名称。');
  }
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
  const currentPrimary = String(config?.agents?.defaults?.model?.primary || '').trim();
  const modelRefs = collectConfiguredModelRefs(config);

  const entries = modelRefs
    .map((modelRef) => {
      const settings = config?.agents?.defaults?.models?.[modelRef] || null;
      const resolved = describeConfiguredModel(config, modelRef);

      return {
        alias: settings?.alias || '',
        modelRef,
        modelName: resolved.modelName,
        providerId: resolved.providerId,
        baseUrl: resolved.baseUrl,
        isDefault: modelRef === currentPrimary,
      };
    })
    .sort((left, right) => {
      if (left.isDefault !== right.isDefault) {
        return left.isDefault ? -1 : 1;
      }

      const aliasOrder = (left.alias || '~').localeCompare(right.alias || '~');
      if (aliasOrder !== 0) {
        return aliasOrder;
      }
      return left.modelRef.localeCompare(right.modelRef);
    });

  return {
    entries,
    currentDefault: currentPrimary ? describeCurrentDefaultModel(config, currentPrimary) : null,
  };
}

function collectConfiguredModelRefs(config) {
  const modelRefs = new Set();

  const providers = config?.models?.providers || {};
  Object.entries(providers).forEach(([providerId, provider]) => {
    const models = Array.isArray(provider?.models) ? provider.models : [];
    models.forEach((model) => {
      if (model && typeof model.id === 'string' && model.id.trim()) {
        modelRefs.add(`${providerId}/${model.id}`);
      }
    });
  });

  Object.keys(config?.agents?.defaults?.models || {}).forEach((modelRef) => {
    if (modelRef) {
      modelRefs.add(modelRef);
    }
  });

  const defaultPrimary = String(config?.agents?.defaults?.model?.primary || '').trim();
  if (defaultPrimary) {
    modelRefs.add(defaultPrimary);
  }

  const defaultFallbacks = Array.isArray(config?.agents?.defaults?.model?.fallbacks)
    ? config.agents.defaults.model.fallbacks
    : [];
  defaultFallbacks.forEach((modelRef) => {
    if (modelRef) {
      modelRefs.add(modelRef);
    }
  });

  const agentList = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  agentList.forEach((agent) => {
    const primary = String(agent?.model?.primary || '').trim();
    if (primary) {
      modelRefs.add(primary);
    }

    const fallbacks = Array.isArray(agent?.model?.fallbacks) ? agent.model.fallbacks : [];
    fallbacks.forEach((modelRef) => {
      if (modelRef) {
        modelRefs.add(modelRef);
      }
    });
  });

  return Array.from(modelRefs);
}

function describeConfiguredModel(config, modelRef) {
  const [providerId, modelId] = splitModelRef(modelRef);
  const provider = config?.models?.providers?.[providerId];
  const providerModels = Array.isArray(provider?.models) ? provider.models : [];
  const model = providerModels.find((entry) => entry && entry.id === modelId);

  return {
    providerId,
    modelId,
    modelName: model?.name || modelId,
    baseUrl: provider?.baseUrl || '',
  };
}

function describeCurrentDefaultModel(config, modelRef) {
  const resolved = describeConfiguredModel(config, modelRef);
  const alias = String(config?.agents?.defaults?.models?.[modelRef]?.alias || '').trim();

  return {
    alias,
    modelRef,
    modelName: resolved.modelName,
    providerId: resolved.providerId,
    baseUrl: resolved.baseUrl,
  };
}

function deleteModelFromConfig(config, selector, options = {}) {
  ensureConfigContainers(config);

  const modelRef = resolveModelRefBySelector(config, selector);
  if (!modelRef) {
    throw new Error(`未找到模型标识为 ${selector} 的模型`);
  }

  const resolved = describeResolvedModel(config, modelRef);
  const usages = findModelUsages(config, modelRef);
  if (usages.length > 0 && !options.force) {
    throw new Error(`模型 ${modelRef} 当前正在被使用：${usages.join(', ')}。请先切换默认模型或 Agent 模型，或使用 --force 强制删除`);
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
    alias: resolved.alias,
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
  console.log(`Alias removed: ${result.alias || '-'}`);
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

function printDefaultSummary(result, configPath, backupPath) {
  console.log(`Default alias: ${result.alias || '-'}`);
  console.log(`${result.changed ? 'Default model set' : 'Default model unchanged'}: ${result.modelRef}`);

  if (result.previousModelRef && result.previousModelRef !== result.modelRef) {
    const previousLabel = result.previousAlias
      ? `${result.previousAlias} (${result.previousModelRef})`
      : result.previousModelRef;
    console.log(`Previous default: ${previousLabel}`);
  }

  console.log(`Config path: ${configPath}`);

  if (backupPath) {
    console.log(`Backup path: ${backupPath}`);
  }
}

function printTestSummary(result) {
  console.log(`Alias tested: ${result.alias || '-'}`);
  console.log(`Model tested: ${result.modelRef}`);
  console.log(`Provider used: ${result.providerId}`);
  console.log(`Base URL: ${result.baseUrl}`);
  console.log(`Endpoint used: ${result.endpointUrl}`);
  console.log('Test result: ok');

  if (result.responseId) {
    console.log(`Response id: ${result.responseId}`);
  }

  if (result.responsePreview) {
    console.log(`Response preview: ${result.responsePreview}`);
  }
}

function printModelList(result) {
  const entries = Array.isArray(result?.entries) ? result.entries : [];
  const currentDefault = result?.currentDefault || null;

  if (currentDefault) {
    const currentDefaultLabel = currentDefault.alias
      ? `${currentDefault.alias} (${currentDefault.modelRef})`
      : currentDefault.modelRef;
    console.log(`Current default: ${currentDefaultLabel}`);
  } else {
    console.log('Current default: -');
  }

  if (entries.length === 0) {
    console.log('No configured models found.');
    return;
  }

  const columns = [
    ['defaultMark', 'DEFAULT'],
    ['alias', 'ALIAS'],
    ['modelRef', 'MODEL'],
    ['modelName', 'NAME'],
    ['baseUrl', 'BASE_URL'],
  ];

  const rows = entries.map((entry) => ({
    defaultMark: entry.isDefault ? 'yes' : '-',
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
    defaultMark: 'DEFAULT',
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
  openclaw-model add --discover <base_url> <模型名称> <模型别名>
  openclaw-model add
  openclaw-model add --discover
  openclaw-model list
  openclaw-model search <base_url>
  openclaw-model search
  openclaw-model test <模型别名或模型引用> [测试提示词]
  openclaw-model test
  openclaw-model default <模型别名或模型引用>
  openclaw-model default
  openclaw-model del <模型别名或模型引用>
  openclaw-model del
  openclaw-model del --force <模型别名或模型引用>
  openclaw-model --config /path/to/openclaw.json --dry-run add
  openclaw-model --config /path/to/openclaw.json --dry-run add --discover <base_url> <模型名称> <模型别名>
  openclaw-model --config /path/to/openclaw.json --dry-run default <模型别名或模型引用>
  openclaw-model --config /path/to/openclaw.json --dry-run del <模型别名或模型引用>

示例:
  openclaw-model add https://api.example.com/v1 sk-xxxx gpt-4.1 gpt41
  openclaw-model add --discover https://api.example.com/v1 gpt-4.1 gpt41
  openclaw-model search https://api.example.com/v1
  openclaw-model test gpt41
  openclaw-model test provider-a/gpt-4.1
  openclaw-model default gpt41
  openclaw-model default provider-a/gpt-4.1
  openclaw-model list
  openclaw-model del gpt41
  openclaw-model del --force gpt41

说明:
  - add 仅需输入 base_url、api_key、模型名称、模型别名
  - add --discover 会复用已保存的 provider，并调用 <base_url>/models 搜索远端模型
  - search 会复用已保存的 provider，并调用 <base_url>/models 列出远端可用模型
  - test 会按模型别名或模型引用找到已配置模型，并调用 <base_url>/chat/completions 验证可用性
  - default 会按模型别名或模型引用切换 agents.defaults.model.primary
  - list 会从 models.providers、agents.defaults.models 和当前引用关系聚合模型，并标记当前默认模型
  - del 会按模型别名或模型引用删除 models.providers 和 agents.defaults.models 中对应条目
  - 若模型正被 agents.defaults.model 或 agents.list[*].model 使用，del 会拒绝删除；可用 --force 覆盖
  - 若同一个 base_url + api_key 已存在，会复用现有 provider
  - 若 provider 不存在，会自动生成 provider id
  - 写入前会自动备份 openclaw.json`);
}

main();
