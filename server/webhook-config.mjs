export const SUPPORTED_WEBHOOK_EVENTS = ['pr:opened', 'pr:from_ref_updated'];
export const WEBHOOK_ACTIONS = ['run', 'queue', 'sync'];

export const DEFAULT_WEBHOOK_SETTINGS = Object.freeze({
  enabled: false,
  publicBaseUrl: '',
  secretEnvName: 'PR_MONITOR_WEBHOOK_SECRET',
  acceptedEvents: [...SUPPORTED_WEBHOOK_EVENTS],
  targetBranches: ['*'],
  action: 'run',
  repoOwners: {},
  maxBodyBytes: 1_048_576
});

function stringList(value, fallback = []) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[\n,]+/);
  const normalized = [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
  return normalized.length ? normalized : [...fallback];
}

function normalizeRepoOwners(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([repo, userId]) => [String(repo).trim().replace(/^\/+|\/+$/g, ''), String(userId).trim()])
    .filter(([repo, userId]) => repo && userId));
}

export function normalizeWebhookSettings(value = {}) {
  const acceptedEvents = stringList(value.acceptedEvents, DEFAULT_WEBHOOK_SETTINGS.acceptedEvents)
    .filter((eventKey) => SUPPORTED_WEBHOOK_EVENTS.includes(eventKey));
  const targetBranches = stringList(value.targetBranches, DEFAULT_WEBHOOK_SETTINGS.targetBranches);
  const maxBodyBytes = Number(value.maxBodyBytes);
  return {
    enabled: value.enabled === true || value.enabled === 'true',
    publicBaseUrl: String(value.publicBaseUrl || '').trim().replace(/\/+$/, ''),
    secretEnvName: /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value.secretEnvName || '').trim())
      ? String(value.secretEnvName).trim()
      : DEFAULT_WEBHOOK_SETTINGS.secretEnvName,
    acceptedEvents: acceptedEvents.length ? acceptedEvents : [...DEFAULT_WEBHOOK_SETTINGS.acceptedEvents],
    targetBranches: targetBranches.length ? targetBranches : [...DEFAULT_WEBHOOK_SETTINGS.targetBranches],
    action: WEBHOOK_ACTIONS.includes(value.action) ? value.action : DEFAULT_WEBHOOK_SETTINGS.action,
    repoOwners: normalizeRepoOwners(value.repoOwners),
    maxBodyBytes: Number.isFinite(maxBodyBytes)
      ? Math.min(10_485_760, Math.max(1_024, Math.trunc(maxBodyBytes)))
      : DEFAULT_WEBHOOK_SETTINGS.maxBodyBytes
  };
}

export function validateWebhookSettingsInput(value = {}) {
  if (value.secretEnvName !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value.secretEnvName).trim())) {
    throw new Error('Secret 环境变量名格式无效。');
  }
  if (value.action !== undefined && !WEBHOOK_ACTIONS.includes(value.action)) {
    throw new Error('Webhook 动作必须是 run、queue 或 sync。');
  }
  if (value.acceptedEvents !== undefined) {
    const events = stringList(value.acceptedEvents);
    if (!events.length || events.some((eventKey) => !SUPPORTED_WEBHOOK_EVENTS.includes(eventKey))) {
      throw new Error('Webhook 事件仅支持 pr:opened 和 pr:from_ref_updated。');
    }
  }
  if (value.targetBranches !== undefined && !stringList(value.targetBranches).length) {
    throw new Error('至少需要配置一个目标分支规则。');
  }
  if (value.maxBodyBytes !== undefined) {
    const size = Number(value.maxBodyBytes);
    if (!Number.isInteger(size) || size < 1_024 || size > 10_485_760) {
      throw new Error('Webhook 请求上限必须是 1024 到 10485760 字节之间的整数。');
    }
  }
  if (value.publicBaseUrl) {
    let parsed;
    try {
      parsed = new URL(String(value.publicBaseUrl).trim());
    } catch {
      throw new Error('外部访问地址必须是有效的 HTTP 或 HTTPS URL。');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('外部访问地址必须使用 HTTP 或 HTTPS。');
    }
  }
  return normalizeWebhookSettings(value);
}

export function webhookSettingsForClient(value = {}, environment = process.env) {
  const settings = normalizeWebhookSettings(value);
  return {
    ...settings,
    endpointUrl: settings.publicBaseUrl ? `${settings.publicBaseUrl}/api/webhooks/bitbucket` : '',
    secretConfigured: Boolean(environment[settings.secretEnvName])
  };
}
