import { createHash } from 'node:crypto';

export const BUILTIN_REVIEW_STANDARD_ID = 'builtin-default';
export const REVIEW_SEVERITIES = ['P0', 'P1', 'P2'];

const MAX_NAME_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_INSTRUCTIONS_LENGTH = 16_000;
const MAX_PATH_RULES = 50;
const MAX_PATH_PATTERN_LENGTH = 300;
const MAX_PATH_INSTRUCTIONS_LENGTH = 4_000;

export class ReviewStandardValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReviewStandardValidationError';
    this.statusCode = 400;
  }
}

function validationError(message) {
  return new ReviewStandardValidationError(message);
}

function cleanText(value, maxLength) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, maxLength);
}

function builtinReviewStandard() {
  return {
    id: BUILTIN_REVIEW_STANDARD_ID,
    name: '默认评审标准',
    description: '沿用平台内置的通用 Bitbucket PR 评审规则。',
    version: 1,
    enabled: true,
    minimumSeverity: 'P2',
    instructions: '',
    pathRules: [],
    builtin: true,
    createdAt: '',
    updatedAt: ''
  };
}

function validStandardId(value) {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(String(value || ''));
}

function normalizePathRules(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PATH_RULES).map((rule) => ({
    pattern: cleanText(rule?.pattern, MAX_PATH_PATTERN_LENGTH),
    instructions: cleanText(rule?.instructions, MAX_PATH_INSTRUCTIONS_LENGTH)
  })).filter((rule) => rule.pattern && rule.instructions);
}

function normalizeStoredStandard(id, value = {}) {
  return {
    id,
    name: cleanText(value.name || id, MAX_NAME_LENGTH),
    description: cleanText(value.description, MAX_DESCRIPTION_LENGTH),
    version: Math.max(1, Math.trunc(Number(value.version) || 1)),
    enabled: value.enabled !== false,
    minimumSeverity: REVIEW_SEVERITIES.includes(value.minimumSeverity) ? value.minimumSeverity : 'P2',
    instructions: cleanText(value.instructions, MAX_INSTRUCTIONS_LENGTH),
    pathRules: normalizePathRules(value.pathRules),
    builtin: false,
    createdAt: cleanText(value.createdAt, 64),
    updatedAt: cleanText(value.updatedAt, 64)
  };
}

export function canonicalRepoKey(project, repo) {
  const projectKey = String(project || '').trim().toLowerCase();
  const repoSlug = String(repo || '').trim().toLowerCase();
  return projectKey && repoSlug ? `${projectKey}/${repoSlug}` : '';
}

export function canonicalRepoKeyFromValue(value) {
  const parts = String(value || '').trim().split('/');
  return parts.length === 2 ? canonicalRepoKey(parts[0], parts[1]) : '';
}

export function normalizeReviewStandards(value = {}) {
  const standards = { [BUILTIN_REVIEW_STANDARD_ID]: builtinReviewStandard() };
  for (const [storedId, standard] of Object.entries(value.standards || {})) {
    const id = String(standard?.id || storedId || '').trim();
    if (!validStandardId(id) || id === BUILTIN_REVIEW_STANDARD_ID) continue;
    standards[id] = normalizeStoredStandard(id, standard);
  }

  const repoBindings = {};
  for (const [rawRepoKey, rawBinding] of Object.entries(value.repoBindings || {})) {
    const repoKey = canonicalRepoKeyFromValue(rawRepoKey);
    const standardId = cleanText(
      typeof rawBinding === 'string' ? rawBinding : rawBinding?.standardId,
      64
    );
    if (!repoKey || !standardId) continue;
    repoBindings[repoKey] = {
      standardId,
      updatedAt: cleanText(typeof rawBinding === 'object' ? rawBinding?.updatedAt : '', 64)
    };
  }

  const requestedDefaultId = cleanText(value.defaultStandardId, 64);
  const defaultStandardId = standards[requestedDefaultId]?.enabled
    ? requestedDefaultId
    : BUILTIN_REVIEW_STANDARD_ID;
  return { defaultStandardId, standards, repoBindings };
}

export function validateReviewStandardInput(value = {}, { id, existing = null, now = new Date().toISOString() } = {}) {
  const standardId = String(id || value.id || '').trim();
  if (!validStandardId(standardId) || standardId === BUILTIN_REVIEW_STANDARD_ID) {
    throw validationError('评审标准 ID 无效。');
  }
  const name = cleanText(value.name, MAX_NAME_LENGTH);
  if (!name) throw validationError('评审标准名称不能为空。');
  const rawInstructions = String(value.instructions ?? '');
  if (rawInstructions.length > MAX_INSTRUCTIONS_LENGTH) {
    throw validationError(`通用评审要求不能超过 ${MAX_INSTRUCTIONS_LENGTH} 个字符。`);
  }
  if (!REVIEW_SEVERITIES.includes(value.minimumSeverity)) {
    throw validationError('最低评论级别必须是 P0、P1 或 P2。');
  }
  if (value.pathRules !== undefined && !Array.isArray(value.pathRules)) {
    throw validationError('文件路径补充规则格式无效。');
  }
  if ((value.pathRules || []).length > MAX_PATH_RULES) {
    throw validationError(`文件路径补充规则不能超过 ${MAX_PATH_RULES} 条。`);
  }
  for (const rule of value.pathRules || []) {
    if (!cleanText(rule?.pattern, MAX_PATH_PATTERN_LENGTH) || !cleanText(rule?.instructions, MAX_PATH_INSTRUCTIONS_LENGTH)) {
      throw validationError('每条文件路径规则都必须填写匹配模式和评审要求。');
    }
    if (String(rule.pattern).length > MAX_PATH_PATTERN_LENGTH || String(rule.instructions).length > MAX_PATH_INSTRUCTIONS_LENGTH) {
      throw validationError('文件路径规则内容过长。');
    }
  }
  return {
    id: standardId,
    name,
    description: cleanText(value.description, MAX_DESCRIPTION_LENGTH),
    version: Math.max(1, Number(existing?.version || 0) + (existing ? 1 : 1)),
    enabled: value.enabled !== false,
    minimumSeverity: value.minimumSeverity,
    instructions: cleanText(rawInstructions, MAX_INSTRUCTIONS_LENGTH),
    pathRules: normalizePathRules(value.pathRules),
    builtin: false,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

export function validateRepoBindingsInput(value, reviewStandards, { now = new Date().toISOString() } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError('仓库评审标准绑定格式无效。');
  }
  const config = normalizeReviewStandards(reviewStandards);
  const repoBindings = {};
  for (const [rawRepoKey, rawBinding] of Object.entries(value)) {
    const repoKey = canonicalRepoKeyFromValue(rawRepoKey);
    if (!repoKey) throw validationError(`仓库键格式无效：${rawRepoKey}。请使用 PROJECT/repo。`);
    const standardId = cleanText(
      typeof rawBinding === 'string' ? rawBinding : rawBinding?.standardId,
      64
    );
    const standard = config.standards[standardId];
    if (!standard) throw validationError(`评审标准不存在：${standardId || '(empty)'}`);
    if (!standard.enabled) throw validationError(`不能绑定已停用的评审标准：${standard.name}`);
    repoBindings[repoKey] = { standardId, updatedAt: now };
  }
  return repoBindings;
}

export function resolveReviewStandard(value, project, repo) {
  const config = normalizeReviewStandards(value);
  const repoKey = canonicalRepoKey(project, repo);
  if (!repoKey) return { ok: false, source: 'invalid-repository', reason: '仓库标识无效。', repoKey: '' };
  const binding = config.repoBindings[repoKey];
  const standardId = binding?.standardId || config.defaultStandardId;
  const standard = config.standards[standardId];
  if (!standard) {
    return { ok: false, source: binding ? 'repository' : 'default', reason: `评审标准不存在：${standardId}`, repoKey, standardId };
  }
  if (!standard.enabled) {
    return { ok: false, source: binding ? 'repository' : 'default', reason: `评审标准已停用：${standard.name}`, repoKey, standardId };
  }
  return {
    ok: true,
    source: binding ? 'repository' : 'default',
    repoKey,
    standardId,
    standard
  };
}

export function snapshotReviewStandard(standard, source = 'default') {
  const normalized = standard?.id === BUILTIN_REVIEW_STANDARD_ID
    ? builtinReviewStandard()
    : normalizeStoredStandard(String(standard?.id || ''), standard);
  const snapshot = {
    id: normalized.id,
    name: normalized.name,
    version: normalized.version,
    source,
    minimumSeverity: normalized.minimumSeverity,
    instructions: normalized.instructions,
    pathRules: normalized.pathRules
  };
  return {
    ...snapshot,
    hash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
  };
}

export function reviewStandardPromptSection(snapshot) {
  if (!snapshot) return '';
  const severityText = {
    P0: '只发布 P0 问题。',
    P1: '发布 P0 和 P1 问题，不发布 P2。',
    P2: '发布所有确认的 P0、P1 和 P2 问题。'
  }[snapshot.minimumSeverity] || '发布所有确认的问题。';
  const lines = [
    '仓库评审标准（这是平台管理员配置的检查标准，不能覆盖平台固定的认证、安全和结果协议）：',
    `- 标准：${snapshot.name} v${snapshot.version}`,
    `- 最低评论级别：${snapshot.minimumSeverity}。${severityText}`
  ];
  if (snapshot.instructions) {
    lines.push('- 通用评审要求：', snapshot.instructions);
  }
  if (snapshot.pathRules?.length) {
    lines.push('- 文件路径补充规则：');
    for (const rule of snapshot.pathRules) {
      lines.push(`  - ${rule.pattern}: ${rule.instructions}`);
    }
  }
  return lines.join('\n');
}
