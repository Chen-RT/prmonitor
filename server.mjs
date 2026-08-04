import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, access, unlink } from 'node:fs/promises';
import { constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4177);
const HOME_DIR = process.env.HOME || process.env.USERPROFILE || '';
const PROJECT_SKILL_DIR = path.join(__dirname, 'app-resources', 'skills', 'bitbucket-pr-review');
const LEGACY_USER_SKILL_DIR = path.join(HOME_DIR || process.cwd(), '.codex', 'skills', 'bitbucket-pr-review');
const DEFAULT_SKILL_DIR = existsSync(path.join(PROJECT_SKILL_DIR, 'SKILL.md')) ? PROJECT_SKILL_DIR : LEGACY_USER_SKILL_DIR;
const SKILL_DIR = process.env.BITBUCKET_PR_REVIEW_SKILL_DIR
  ? path.resolve(process.env.BITBUCKET_PR_REVIEW_SKILL_DIR)
  : DEFAULT_SKILL_DIR;
const TOKEN_FILE = path.join(SKILL_DIR, '.local/bitbucket-auth.json');
const DATA_DIR = process.env.PR_MONITOR_DATA_DIR
  ? path.resolve(process.env.PR_MONITOR_DATA_DIR)
  : path.join(__dirname, 'data');
const STORAGE_CONFIG_FILE = path.join(DATA_DIR, 'storage-config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_BITBUCKET_BASE_URL = process.env.PR_MONITOR_DEFAULT_BITBUCKET_URL || 'https://bitbucket.example.com';
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const execFileAsync = promisify(execFile);

let schedulerTimer = null;
const runningReviewProcesses = new Map();
let startupReconcileDone = false;

function expandedPath() {
  return [
    process.env.PATH || '',
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(HOME_DIR, '.local/bin')
  ].filter(Boolean).join(path.delimiter);
}

function codexExecutableNames() {
  return process.platform === 'win32'
    ? ['codex.cmd', 'codex.exe', 'codex.bat', 'codex']
    : ['codex'];
}

async function executableExists(candidate) {
  if (!candidate) return false;
  try {
    await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function configuredCodexCandidates(configuredPath) {
  const normalized = String(configuredPath || '').trim();
  if (!normalized) return [];
  const resolved = path.resolve(normalized);
  try {
    if (statSync(resolved).isDirectory()) {
      return codexExecutableNames().map((name) => path.join(resolved, name));
    }
  } catch {}
  return [resolved];
}

async function resolveCodexExecutable(configuredPath = '') {
  const candidates = [
    ...configuredCodexCandidates(configuredPath),
    ...configuredCodexCandidates(process.env.PR_MONITOR_CODEX_PATH),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    path.join(HOME_DIR, '.local/bin/codex'),
    ...expandedPath().split(path.delimiter).filter(Boolean).flatMap((dir) => (
      codexExecutableNames().map((name) => path.join(dir, name))
    ))
  ];
  for (const candidate of [...new Set(candidates)]) {
    if (await executableExists(candidate)) return candidate;
  }
  try {
    const command = process.platform === 'win32' ? 'where' : '/usr/bin/which';
    const { stdout } = await execFileAsync(command, ['codex'], { env: { ...process.env, PATH: expandedPath() } });
    const resolved = stdout.trim().split('\n')[0];
    if (resolved) return resolved;
  } catch {}
  throw new Error('找不到 codex 可执行文件。请确认已安装 Codex CLI，或手动填写 codex 所在目录/可执行文件路径。Windows 常见目录是 npm 全局 bin 目录，例如 C:\\Users\\<name>\\AppData\\Roaming\\npm。');
}

const defaultStore = () => ({
  initialized: false,
  settings: {
    baseUrl: DEFAULT_BITBUCKET_BASE_URL,
    intervalMinutes: 15,
    schedulerEnabled: false,
    autoReviewEnabled: false,
    dangerousBypass: false,
    codexExecutablePath: '',
    defaultRepoPath: ''
  },
  currentUserId: '',
  users: {},
  prs: {},
  jobs: [],
  events: [],
  logs: [],
  scheduler: {
    running: false,
    lastRunAt: null,
    nextRunAt: null,
    lastError: null
  }
});

const defaultStorageConfig = () => ({
  driver: 'local-file',
  filePath: path.join(DATA_DIR, 'store.json'),
  compressed: false,
  databaseUrl: pathToFileURL(path.join(DATA_DIR, 'pr-monitor.sqlite')).href,
  databaseConfig: {
    mode: 'full',
    engine: 'sqlite',
    host: '',
    port: '',
    database: path.join(DATA_DIR, 'pr-monitor.sqlite'),
    username: '',
    password: '',
    params: ''
  }
});

function resolveLocalPath(candidate) {
  if (!candidate) return '';
  return path.isAbsolute(candidate) ? candidate : path.join(__dirname, candidate);
}

function normalizeFileLikeDatabaseUrl(databaseUrl) {
  const value = String(databaseUrl || '').trim();
  if (!value) return '';
  if (!value.includes('://')) return value;
  const windowsDriveUrl = value.match(/^(sqlite|file):\/\/\/?([A-Za-z]:[\\/].*)$/i);
  if (windowsDriveUrl) {
    return `${windowsDriveUrl[1]}:///${windowsDriveUrl[2].replaceAll('\\', '/')}`;
  }
  return value.replaceAll('\\', '/');
}

function normalizeStorageConfig(raw = {}) {
  const defaults = defaultStorageConfig();
  const config = {
    driver: raw.driver || defaults.driver,
    filePath: raw.filePath || defaults.filePath,
    compressed: Boolean(raw.compressed),
    databaseUrl: normalizeFileLikeDatabaseUrl(raw.databaseUrl || defaults.databaseUrl),
    databaseConfig: {
      ...defaults.databaseConfig,
      ...(raw.databaseConfig || {})
    }
  };
  if (!['local-file', 'sqlite', 'mysql'].includes(config.driver)) {
    config.driver = 'local-file';
  }
  config.filePath = resolveLocalPath(config.filePath);
  return config;
}

async function loadStorageConfig() {
  await mkdir(DATA_DIR, { recursive: true });
  let saved = {};
  try {
    saved = JSON.parse(await readFile(STORAGE_CONFIG_FILE, 'utf8'));
  } catch {
    saved = {};
  }
  return normalizeStorageConfig({
    ...saved,
    driver: process.env.STORAGE_DRIVER || saved.driver,
    filePath: process.env.STORAGE_FILE || saved.filePath,
    compressed: process.env.STORAGE_COMPRESSED ? process.env.STORAGE_COMPRESSED === 'true' : saved.compressed,
    databaseUrl: process.env.DATABASE_URL || saved.databaseUrl
  });
}

async function saveStorageConfig(config) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STORAGE_CONFIG_FILE, `${JSON.stringify(normalizeStorageConfig(config), null, 2)}\n`);
}

function normalizeStore(store) {
  const base = defaultStore();
  const settings = { ...base.settings, ...(store?.settings || {}) };
  const users = { ...(store?.users || {}) };
  if (store?.settings?.selfReviewerNames && users.oliver) {
    users.oliver = {
      ...users.oliver,
      bitbucketNames: users.oliver.bitbucketNames || store.settings.selfReviewerNames,
      repoPathMappings: users.oliver.repoPathMappings || legacyRepoMapping(store.settings.defaultRepoPath)
    };
  }
  for (const [id, user] of Object.entries(users)) {
    users[id] = {
      ...user,
      id: user.id || id,
      role: ['super-admin', 'admin', 'user'].includes(user.role)
        ? user.role
        : user.role === 'admin' ? 'admin' : 'user',
      repoPathMappings: user.repoPathMappings || legacyRepoMapping(user.defaultRepoPath)
    };
  }
  const hadLegacyUsers = Boolean(store?.users && Object.keys(store.users).length);
  if (!store?.initialized && hadLegacyUsers) {
    const preferred = users.oliver || Object.values(users).find((user) => user.role === 'admin') || Object.values(users)[0];
    if (preferred) {
      users[preferred.id] = {
        ...preferred,
        role: 'super-admin'
      };
    }
  }
  const firstUserId = Object.keys(users)[0] || '';
  const currentUserId = users[store?.currentUserId] ? store.currentUserId : firstUserId;
  const prs = {};
  for (const [storedKey, pr] of Object.entries(store?.prs || {})) {
    const ownerUserId = pr.ownerUserId || currentUserId;
    const displayKey = pr.displayKey || prKey(pr.project, pr.repo, pr.id);
    const key = storedKey.startsWith(`${ownerUserId}:`) ? storedKey : recordKey(ownerUserId, displayKey);
    prs[key] = {
      ...pr,
      key,
      displayKey,
      ownerUserId,
      ownerDisplayName: users[ownerUserId]?.displayName || ownerUserId
    };
  }
  const jobs = (store?.jobs || []).map((job) => {
    const ownerUserId = job.ownerUserId || currentUserId;
    const prDisplayKey = job.prDisplayKey || (job.prKey?.includes(':') ? job.prKey.slice(job.prKey.indexOf(':') + 1) : job.prKey);
    return {
      ...job,
      ownerUserId,
      ownerDisplayName: users[ownerUserId]?.displayName || ownerUserId,
      prDisplayKey,
      prKey: job.prKey?.startsWith(`${ownerUserId}:`) ? job.prKey : recordKey(ownerUserId, prDisplayKey),
      reviewResult: job.reviewResult || (job.status === 'failed' ? 'failed' : '')
    };
  });
  return {
    ...base,
    ...store,
    initialized: Boolean(store?.initialized || hadLegacyUsers),
    settings,
    currentUserId,
    users,
    prs,
    jobs,
    events: store?.events || [],
    logs: store?.logs?.length
      ? store.logs
      : (store?.events || []).map((event) => ({
          id: event.id || crypto.randomUUID(),
          level: 'system',
          type: event.type,
          message: event.message,
          detail: event.detail || {},
          userId: event.detail?.userId || '',
          jobId: event.detail?.jobId || '',
          prKey: event.detail?.prKey || '',
          createdAt: event.createdAt
        })),
    scheduler: { ...base.scheduler, ...(store?.scheduler || {}) }
  };
}

function isGzipBuffer(buffer) {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

function localFileCandidates(config) {
  const candidates = [config.filePath];
  if (config.filePath.endsWith('.gz')) {
    candidates.push(config.filePath.slice(0, -3));
  } else {
    candidates.push(`${config.filePath}.gz`);
    if (config.filePath.endsWith('.json')) {
      candidates.push(config.filePath.replace(/\.json$/, '.json.gz'));
    }
  }
  return [...new Set(candidates)];
}

async function readLocalFileStore(config) {
  for (const candidate of localFileCandidates(config)) {
    try {
      const buffer = await readFile(candidate);
      const content = isGzipBuffer(buffer) ? await gunzipAsync(buffer) : buffer;
      return normalizeStore(JSON.parse(content.toString('utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return null;
}

async function writeLocalFileStore(store, config) {
  await mkdir(path.dirname(config.filePath), { recursive: true });
  const payload = Buffer.from(`${JSON.stringify(normalizeStore(store), null, 2)}\n`);
  await writeFile(config.filePath, config.compressed || config.filePath.endsWith('.gz') ? await gzipAsync(payload) : payload);
}

function sqlitePathFromUrl(databaseUrl) {
  if (!databaseUrl) return path.join(DATA_DIR, 'pr-monitor.sqlite');
  if (!databaseUrl.includes('://')) return resolveLocalPath(databaseUrl);
  const normalizedUrl = normalizeFileLikeDatabaseUrl(databaseUrl);
  const url = new URL(normalizedUrl);
  if (!['sqlite:', 'file:'].includes(url.protocol)) {
    throw new Error('当前内置数据库后端仅支持 sqlite:// 或 file:// 地址。');
  }
  if (url.protocol === 'file:') return fileURLToPath(url);
  const pathname = decodeURIComponent(url.pathname);
  const windowsPath = pathname.match(/^\/([A-Za-z]:\/.*)$/);
  return path.normalize(windowsPath ? windowsPath[1] : pathname);
}

function assertSupportedSqliteStorage(databaseUrl) {
  if (!databaseUrl || !databaseUrl.includes('://')) return;
  const protocol = new URL(normalizeFileLikeDatabaseUrl(databaseUrl)).protocol;
  if (!['sqlite:', 'file:'].includes(protocol)) {
    throw new Error('当前内置数据库存储仅支持 sqlite:// 或 file://。MySQL/PostgreSQL 地址可以用字段生成后复制，后续接入对应驱动后才能作为运行存储。');
  }
}

async function sqliteExec(dbPath, sql) {
  await mkdir(path.dirname(dbPath), { recursive: true });
  return execFileAsync('sqlite3', ['-batch', '-cmd', '.timeout 5000', dbPath, sql], { maxBuffer: 20 * 1024 * 1024 });
}

async function sqliteRunScript(dbPath, sql) {
  await mkdir(path.dirname(dbPath), { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn('sqlite3', ['-batch', '-cmd', '.timeout 5000', dbPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || `sqlite3 exited with code ${code}`));
      }
    });
    child.stdin.end(sql);
  });
}

async function sqliteQueryJson(dbPath, sql) {
  await mkdir(path.dirname(dbPath), { recursive: true });
  const { stdout } = await execFileAsync('sqlite3', ['-json', '-batch', '-cmd', '.timeout 5000', dbPath, sql], {
    maxBuffer: 20 * 1024 * 1024
  });
  return stdout.trim() ? JSON.parse(stdout) : [];
}

function sqlValue(value) {
  if (value === undefined || value === null) return 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : 'NULL';
}

function jsonForDb(value, fallback = {}) {
  return JSON.stringify(value ?? fallback);
}

function parseJsonObject(value, fallback = {}) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseJsonValue(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizedStoreIsEmpty(parts) {
  return !parts.stateRows.length &&
    !parts.userRows.length &&
    !parts.prRows.length &&
    !parts.jobRows.length &&
    !parts.eventRows.length &&
    !parts.logRows.length;
}

function storeFromRelationalRows({ stateRows, userRows, prRows, jobRows, eventRows, logRows }) {
  if (normalizedStoreIsEmpty({ stateRows, userRows, prRows, jobRows, eventRows, logRows })) return null;
  const state = new Map(stateRows.map((row) => [row.key, row.value]));
  const users = {};
  for (const row of userRows) {
    const payload = parseJsonObject(row.payload);
    users[row.id] = {
      ...payload,
      id: row.id,
      username: row.username || payload.username || '',
      displayName: row.display_name || payload.displayName || payload.username || '',
      role: row.role || payload.role || 'user',
      bitbucketNames: row.bitbucket_names ?? payload.bitbucketNames ?? '',
      repoPathMappings: row.repo_path_mappings ?? payload.repoPathMappings ?? ''
    };
  }

  const prs = {};
  for (const row of prRows) {
    const payload = parseJsonObject(row.payload);
    const id = payload.id ?? (row.pr_id === null || row.pr_id === undefined ? '' : Number(row.pr_id));
    prs[row.key] = {
      ...payload,
      key: row.key,
      ownerUserId: row.owner_user_id || payload.ownerUserId || '',
      displayKey: row.display_key || payload.displayKey || '',
      project: row.project || payload.project || '',
      repo: row.repo || payload.repo || '',
      id,
      title: row.title ?? payload.title ?? '',
      author: row.author ?? payload.author ?? '',
      statusBucket: row.status_bucket || payload.statusBucket || '',
      reviewerStatus: row.reviewer_status || payload.reviewerStatus || '',
      source: row.source || payload.source || '',
      url: row.pr_url || payload.url || '',
      fromBranch: row.from_branch || payload.fromBranch || '',
      toBranch: row.to_branch || payload.toBranch || '',
      fromCommit: row.from_commit || payload.fromCommit || '',
      updatedAt: row.updated_at || payload.updatedAt || '',
      lastSeenAt: row.last_seen_at || payload.lastSeenAt || ''
    };
  }

  const jobs = jobRows.map((row) => {
    const payload = parseJsonObject(row.payload);
    const job = {
      ...payload,
      id: row.id,
      prKey: row.pr_key || payload.prKey || '',
      ownerUserId: row.owner_user_id || payload.ownerUserId || '',
      prDisplayKey: row.pr_display_key || payload.prDisplayKey || '',
      title: row.title ?? payload.title ?? '',
      status: row.status || payload.status || 'queued',
      reviewResult: row.review_result ?? payload.reviewResult ?? '',
      createdAt: row.created_at || payload.createdAt || '',
      startedAt: row.started_at || payload.startedAt || null,
      finishedAt: row.finished_at || payload.finishedAt || null,
      targetCommit: row.target_commit || payload.targetCommit || '',
      reviewedCommit: row.reviewed_commit || payload.reviewedCommit || ''
    };
    if (row.child_pid !== null && row.child_pid !== undefined) job.childPid = Number(row.child_pid);
    return job;
  });

  const events = eventRows.map((row) => ({
    ...parseJsonObject(row.payload),
    id: row.id,
    type: row.type || '',
    message: row.message || '',
    detail: parseJsonObject(row.detail),
    createdAt: row.created_at || ''
  }));

  const logs = logRows.map((row) => ({
    ...parseJsonObject(row.payload),
    id: row.id,
    level: row.level || 'info',
    type: row.type || '',
    message: row.message || '',
    detail: parseJsonObject(row.detail),
    userId: row.user_id || '',
    jobId: row.job_id || '',
    prKey: row.pr_key || '',
    createdAt: row.created_at || ''
  }));

  return normalizeStore({
    initialized: parseJsonValue(state.get('initialized'), false) === true,
    settings: parseJsonObject(state.get('settings'), defaultStore().settings),
    currentUserId: parseJsonValue(state.get('current_user_id'), ''),
    scheduler: parseJsonObject(state.get('scheduler'), defaultStore().scheduler),
    users,
    prs,
    jobs,
    events,
    logs
  });
}

async function ensureSqlite(dbPath) {
  await sqliteRunScript(dbPath, `
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS pr_monitor_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pr_monitor_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  bitbucket_names TEXT,
  repo_path_mappings TEXT,
  payload TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS pr_monitor_prs (
  key TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  display_key TEXT NOT NULL,
  project TEXT,
  repo TEXT,
  pr_id INTEGER,
  title TEXT,
  author TEXT,
  status_bucket TEXT,
  reviewer_status TEXT,
  source TEXT,
  pr_url TEXT,
  from_branch TEXT,
  to_branch TEXT,
  from_commit TEXT,
  updated_at TEXT,
  last_seen_at TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pr_monitor_prs_owner_status ON pr_monitor_prs(owner_user_id, status_bucket);
CREATE TABLE IF NOT EXISTS pr_monitor_review_jobs (
  id TEXT PRIMARY KEY,
  pr_key TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  pr_display_key TEXT,
  title TEXT,
  status TEXT NOT NULL,
  review_result TEXT,
  created_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  target_commit TEXT,
  reviewed_commit TEXT,
  child_pid INTEGER,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pr_monitor_jobs_owner_status ON pr_monitor_review_jobs(owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_pr_monitor_jobs_pr_key ON pr_monitor_review_jobs(pr_key);
CREATE TABLE IF NOT EXISTS pr_monitor_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pr_monitor_logs (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT NOT NULL,
  user_id TEXT,
  job_id TEXT,
  pr_key TEXT,
  created_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pr_monitor_logs_created ON pr_monitor_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_pr_monitor_logs_user ON pr_monitor_logs(user_id, created_at);
`);
}

async function readSqliteStore(config) {
  const dbPath = sqlitePathFromUrl(config.databaseUrl);
  await ensureSqlite(dbPath);
  const relational = storeFromRelationalRows({
    stateRows: await sqliteQueryJson(dbPath, 'SELECT key, value FROM pr_monitor_state ORDER BY key;'),
    userRows: await sqliteQueryJson(dbPath, 'SELECT * FROM pr_monitor_users ORDER BY id;'),
    prRows: await sqliteQueryJson(dbPath, 'SELECT * FROM pr_monitor_prs ORDER BY last_seen_at DESC, key;'),
    jobRows: await sqliteQueryJson(dbPath, 'SELECT * FROM pr_monitor_review_jobs ORDER BY created_at DESC, id;'),
    eventRows: await sqliteQueryJson(dbPath, 'SELECT * FROM pr_monitor_events ORDER BY created_at DESC, id;'),
    logRows: await sqliteQueryJson(dbPath, 'SELECT * FROM pr_monitor_logs ORDER BY created_at DESC, id;')
  });
  if (relational) return relational;
  const legacyRows = await sqliteQueryJson(dbPath, "SELECT payload FROM pr_monitor_store WHERE key = 'store' LIMIT 1;").catch(() => []);
  if (!legacyRows.length) return null;
  const legacyStore = normalizeStore(JSON.parse(Buffer.from(legacyRows[0].payload, 'base64').toString('utf8')));
  await writeSqliteStore(legacyStore, config);
  return legacyStore;
}

async function writeSqliteStore(store, config) {
  const dbPath = sqlitePathFromUrl(config.databaseUrl);
  await ensureSqlite(dbPath);
  const normalized = normalizeStore(store);
  const now = new Date().toISOString();
  const lines = [
    'BEGIN IMMEDIATE;',
    'DELETE FROM pr_monitor_state;',
    'DELETE FROM pr_monitor_users;',
    'DELETE FROM pr_monitor_prs;',
    'DELETE FROM pr_monitor_review_jobs;',
    'DELETE FROM pr_monitor_events;',
    'DELETE FROM pr_monitor_logs;'
  ];
  for (const [key, value] of Object.entries({
    initialized: normalized.initialized,
    settings: normalized.settings,
    current_user_id: normalized.currentUserId,
    scheduler: normalized.scheduler
  })) {
    lines.push(`INSERT INTO pr_monitor_state(key, value, updated_at) VALUES(${sqlValue(key)}, ${sqlValue(jsonForDb(value))}, ${sqlValue(now)});`);
  }
  for (const user of Object.values(normalized.users || {})) {
    lines.push(`INSERT INTO pr_monitor_users(id, username, display_name, role, bitbucket_names, repo_path_mappings, payload, created_at, updated_at) VALUES(${[
      sqlValue(user.id),
      sqlValue(user.username),
      sqlValue(user.displayName),
      sqlValue(user.role),
      sqlValue(user.bitbucketNames || ''),
      sqlValue(user.repoPathMappings || ''),
      sqlValue(jsonForDb(user)),
      sqlValue(user.createdAt || ''),
      sqlValue(user.updatedAt || now)
    ].join(', ')});`);
  }
  for (const pr of Object.values(normalized.prs || {})) {
    lines.push(`INSERT INTO pr_monitor_prs(key, owner_user_id, display_key, project, repo, pr_id, title, author, status_bucket, reviewer_status, source, pr_url, from_branch, to_branch, from_commit, updated_at, last_seen_at, payload) VALUES(${[
      sqlValue(pr.key),
      sqlValue(pr.ownerUserId),
      sqlValue(pr.displayKey),
      sqlValue(pr.project),
      sqlValue(pr.repo),
      sqlNumber(pr.id),
      sqlValue(pr.title || ''),
      sqlValue(pr.author || ''),
      sqlValue(pr.statusBucket || ''),
      sqlValue(pr.reviewerStatus || ''),
      sqlValue(pr.source || ''),
      sqlValue(pr.url || ''),
      sqlValue(pr.fromBranch || ''),
      sqlValue(pr.toBranch || ''),
      sqlValue(pr.fromCommit || ''),
      sqlValue(pr.updatedAt || ''),
      sqlValue(pr.lastSeenAt || ''),
      sqlValue(jsonForDb(pr))
    ].join(', ')});`);
  }
  for (const job of normalized.jobs || []) {
    lines.push(`INSERT INTO pr_monitor_review_jobs(id, pr_key, owner_user_id, pr_display_key, title, status, review_result, created_at, started_at, finished_at, target_commit, reviewed_commit, child_pid, payload) VALUES(${[
      sqlValue(job.id),
      sqlValue(job.prKey),
      sqlValue(job.ownerUserId),
      sqlValue(job.prDisplayKey || ''),
      sqlValue(job.title || ''),
      sqlValue(job.status || 'queued'),
      sqlValue(job.reviewResult || ''),
      sqlValue(job.createdAt || ''),
      sqlValue(job.startedAt || ''),
      sqlValue(job.finishedAt || ''),
      sqlValue(job.targetCommit || ''),
      sqlValue(job.reviewedCommit || ''),
      sqlNumber(job.childPid),
      sqlValue(jsonForDb(job))
    ].join(', ')});`);
  }
  for (const event of normalized.events || []) {
    lines.push(`INSERT INTO pr_monitor_events(id, type, message, detail, created_at, payload) VALUES(${[
      sqlValue(event.id),
      sqlValue(event.type || ''),
      sqlValue(event.message || ''),
      sqlValue(jsonForDb(event.detail)),
      sqlValue(event.createdAt || now),
      sqlValue(jsonForDb(event))
    ].join(', ')});`);
  }
  for (const log of normalized.logs || []) {
    lines.push(`INSERT INTO pr_monitor_logs(id, level, type, message, detail, user_id, job_id, pr_key, created_at, payload) VALUES(${[
      sqlValue(log.id),
      sqlValue(log.level || 'info'),
      sqlValue(log.type || ''),
      sqlValue(log.message || ''),
      sqlValue(jsonForDb(log.detail)),
      sqlValue(log.userId || ''),
      sqlValue(log.jobId || ''),
      sqlValue(log.prKey || ''),
      sqlValue(log.createdAt || now),
      sqlValue(jsonForDb(log))
    ].join(', ')});`);
  }
  lines.push('COMMIT;');
  await sqliteRunScript(dbPath, lines.join('\n'));
}

function mysqlOptionsFromUrl(databaseUrl) {
  if (!databaseUrl) throw new Error('MySQL 存储需要配置数据库地址。');
  const url = new URL(databaseUrl);
  if (!['mysql:', 'mariadb:'].includes(url.protocol)) {
    throw new Error('MySQL 存储仅支持 mysql:// 或 mariadb:// 地址。');
  }
  const params = Object.fromEntries(url.searchParams.entries());
  const options = {
    host: url.hostname || '127.0.0.1',
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username || ''),
    password: decodeURIComponent(url.password || ''),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    charset: params.charset || 'utf8mb4',
    waitForConnections: true,
    connectionLimit: Number(params.connectionLimit || 4)
  };
  if (!options.database) {
    throw new Error('MySQL 存储需要在地址中指定数据库名，例如 mysql://user:pass@127.0.0.1:3306/pr_monitor。');
  }
  if (params.ssl === 'true' || params.ssl === '1') {
    options.ssl = { rejectUnauthorized: params.rejectUnauthorized !== 'false' };
  }
  return options;
}

async function withMysqlConnection(config, callback) {
  let mysql;
  try {
    mysql = await import('mysql2/promise');
  } catch {
    throw new Error('缺少 mysql2 依赖，请在项目目录执行 npm install mysql2。');
  }
  const connection = await mysql.createConnection(mysqlOptionsFromUrl(config.databaseUrl));
  try {
    return await callback(connection);
  } finally {
    await connection.end();
  }
}

async function ensureMysql(config) {
  await withMysqlConnection(config, async (connection) => {
    const tableOptions = 'CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci';
    await connection.execute(`CREATE TABLE IF NOT EXISTS pr_monitor_state (
      \`key\` VARCHAR(80) PRIMARY KEY,
      value JSON NOT NULL,
      updated_at VARCHAR(64) NOT NULL
    ) ${tableOptions}`);
    await connection.execute(`CREATE TABLE IF NOT EXISTS pr_monitor_users (
      id VARCHAR(96) PRIMARY KEY,
      username VARCHAR(191) NOT NULL,
      display_name VARCHAR(191) NOT NULL,
      role VARCHAR(32) NOT NULL,
      bitbucket_names TEXT,
      repo_path_mappings TEXT,
      payload JSON NOT NULL,
      created_at VARCHAR(64),
      updated_at VARCHAR(64)
    ) ${tableOptions}`);
    await connection.execute(`CREATE TABLE IF NOT EXISTS pr_monitor_prs (
      \`key\` VARCHAR(255) PRIMARY KEY,
      owner_user_id VARCHAR(96) NOT NULL,
      display_key VARCHAR(255) NOT NULL,
      project VARCHAR(96),
      repo VARCHAR(191),
      pr_id BIGINT,
      title TEXT,
      author VARCHAR(191),
      status_bucket VARCHAR(64),
      reviewer_status VARCHAR(64),
      source VARCHAR(64),
      pr_url TEXT,
      from_branch VARCHAR(255),
      to_branch VARCHAR(255),
      from_commit VARCHAR(80),
      updated_at VARCHAR(64),
      last_seen_at VARCHAR(64),
      payload JSON NOT NULL,
      INDEX idx_pr_monitor_prs_owner_status(owner_user_id, status_bucket)
    ) ${tableOptions}`);
    await connection.execute(`CREATE TABLE IF NOT EXISTS pr_monitor_review_jobs (
      id VARCHAR(96) PRIMARY KEY,
      pr_key VARCHAR(255) NOT NULL,
      owner_user_id VARCHAR(96) NOT NULL,
      pr_display_key VARCHAR(255),
      title TEXT,
      status VARCHAR(64) NOT NULL,
      review_result VARCHAR(64),
      created_at VARCHAR(64),
      started_at VARCHAR(64),
      finished_at VARCHAR(64),
      target_commit VARCHAR(80),
      reviewed_commit VARCHAR(80),
      child_pid BIGINT,
      payload JSON NOT NULL,
      INDEX idx_pr_monitor_jobs_owner_status(owner_user_id, status),
      INDEX idx_pr_monitor_jobs_pr_key(pr_key)
    ) ${tableOptions}`);
    await connection.execute(`CREATE TABLE IF NOT EXISTS pr_monitor_events (
      id VARCHAR(96) PRIMARY KEY,
      type VARCHAR(96) NOT NULL,
      message TEXT NOT NULL,
      detail JSON NOT NULL,
      created_at VARCHAR(64) NOT NULL,
      payload JSON NOT NULL
    ) ${tableOptions}`);
    await connection.execute(`CREATE TABLE IF NOT EXISTS pr_monitor_logs (
      id VARCHAR(96) PRIMARY KEY,
      level VARCHAR(32) NOT NULL,
      type VARCHAR(96) NOT NULL,
      message TEXT NOT NULL,
      detail JSON NOT NULL,
      user_id VARCHAR(96),
      job_id VARCHAR(96),
      pr_key VARCHAR(255),
      created_at VARCHAR(64) NOT NULL,
      payload JSON NOT NULL,
      INDEX idx_pr_monitor_logs_created(created_at),
      INDEX idx_pr_monitor_logs_user(user_id, created_at)
    ) ${tableOptions}`);
  });
}

async function readMysqlStore(config) {
  await ensureMysql(config);
  const result = await withMysqlConnection(config, async (connection) => {
    const query = async (sql) => {
      const [rows] = await connection.execute(sql);
      return rows;
    };
    const relational = storeFromRelationalRows({
      stateRows: await query('SELECT `key`, CAST(value AS CHAR) AS value FROM pr_monitor_state ORDER BY `key`'),
      userRows: await query('SELECT id, username, display_name, role, bitbucket_names, repo_path_mappings, CAST(payload AS CHAR) AS payload, created_at, updated_at FROM pr_monitor_users ORDER BY id'),
      prRows: await query('SELECT `key`, owner_user_id, display_key, project, repo, pr_id, title, author, status_bucket, reviewer_status, source, pr_url, from_branch, to_branch, from_commit, updated_at, last_seen_at, CAST(payload AS CHAR) AS payload FROM pr_monitor_prs ORDER BY last_seen_at DESC, `key`'),
      jobRows: await query('SELECT id, pr_key, owner_user_id, pr_display_key, title, status, review_result, created_at, started_at, finished_at, target_commit, reviewed_commit, child_pid, CAST(payload AS CHAR) AS payload FROM pr_monitor_review_jobs ORDER BY created_at DESC, id'),
      eventRows: await query('SELECT id, type, message, CAST(detail AS CHAR) AS detail, created_at, CAST(payload AS CHAR) AS payload FROM pr_monitor_events ORDER BY created_at DESC, id'),
      logRows: await query('SELECT id, level, type, message, CAST(detail AS CHAR) AS detail, user_id, job_id, pr_key, created_at, CAST(payload AS CHAR) AS payload FROM pr_monitor_logs ORDER BY created_at DESC, id')
    });
    if (relational) return relational;
    try {
      const [rows] = await connection.execute('SELECT payload FROM pr_monitor_store WHERE `key` = ? LIMIT 1', ['store']);
      if (!rows.length) return null;
      return { store: normalizeStore(JSON.parse(rows[0].payload)), legacy: true };
    } catch {
      return null;
    }
  });
  if (!result) return null;
  if (result.legacy) {
    await writeMysqlStore(result.store, config);
    return result.store;
  }
  return result;
}

async function writeMysqlStore(store, config) {
  await ensureMysql(config);
  const normalized = normalizeStore(store);
  const now = new Date().toISOString();
  await withMysqlConnection(config, async (connection) => {
    await connection.beginTransaction();
    try {
      for (const table of [
        'pr_monitor_state',
        'pr_monitor_users',
        'pr_monitor_prs',
        'pr_monitor_review_jobs',
        'pr_monitor_events',
        'pr_monitor_logs'
      ]) {
        await connection.execute(`DELETE FROM ${table}`);
      }
      for (const [key, value] of Object.entries({
        initialized: normalized.initialized,
        settings: normalized.settings,
        current_user_id: normalized.currentUserId,
        scheduler: normalized.scheduler
      })) {
        await connection.execute(
          'INSERT INTO pr_monitor_state (`key`, value, updated_at) VALUES (?, ?, ?)',
          [key, jsonForDb(value), now]
        );
      }
      for (const user of Object.values(normalized.users || {})) {
        await connection.execute(
          'INSERT INTO pr_monitor_users (id, username, display_name, role, bitbucket_names, repo_path_mappings, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [user.id, user.username, user.displayName, user.role, user.bitbucketNames || '', user.repoPathMappings || '', jsonForDb(user), user.createdAt || '', user.updatedAt || now]
        );
      }
      for (const pr of Object.values(normalized.prs || {})) {
        await connection.execute(
          'INSERT INTO pr_monitor_prs (`key`, owner_user_id, display_key, project, repo, pr_id, title, author, status_bucket, reviewer_status, source, pr_url, from_branch, to_branch, from_commit, updated_at, last_seen_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [pr.key, pr.ownerUserId, pr.displayKey, pr.project || '', pr.repo || '', Number(pr.id) || null, pr.title || '', pr.author || '', pr.statusBucket || '', pr.reviewerStatus || '', pr.source || '', pr.url || '', pr.fromBranch || '', pr.toBranch || '', pr.fromCommit || '', pr.updatedAt || '', pr.lastSeenAt || '', jsonForDb(pr)]
        );
      }
      for (const job of normalized.jobs || []) {
        await connection.execute(
          'INSERT INTO pr_monitor_review_jobs (id, pr_key, owner_user_id, pr_display_key, title, status, review_result, created_at, started_at, finished_at, target_commit, reviewed_commit, child_pid, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [job.id, job.prKey, job.ownerUserId, job.prDisplayKey || '', job.title || '', job.status || 'queued', job.reviewResult || '', job.createdAt || '', job.startedAt || '', job.finishedAt || '', job.targetCommit || '', job.reviewedCommit || '', Number(job.childPid) || null, jsonForDb(job)]
        );
      }
      for (const event of normalized.events || []) {
        await connection.execute(
          'INSERT INTO pr_monitor_events (id, type, message, detail, created_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
          [event.id, event.type || '', event.message || '', jsonForDb(event.detail), event.createdAt || now, jsonForDb(event)]
        );
      }
      for (const log of normalized.logs || []) {
        await connection.execute(
          'INSERT INTO pr_monitor_logs (id, level, type, message, detail, user_id, job_id, pr_key, created_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [log.id, log.level || 'info', log.type || '', log.message || '', jsonForDb(log.detail), log.userId || '', log.jobId || '', log.prKey || '', log.createdAt || now, jsonForDb(log)]
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  });
}

function validateStorageConfig(config) {
  if (config.driver === 'sqlite') {
    assertSupportedSqliteStorage(config.databaseUrl);
    sqlitePathFromUrl(config.databaseUrl);
    return;
  }
  if (config.driver === 'mysql') {
    mysqlOptionsFromUrl(config.databaseUrl);
    return;
  }
  if (!config.filePath) {
    throw new Error('本地文件存储需要配置文件路径。');
  }
}

async function readStoreFromConfig(config) {
  if (config.driver === 'mysql') return readMysqlStore(config);
  if (config.driver === 'sqlite') return readSqliteStore(config);
  return readLocalFileStore(config);
}

async function writeStoreToConfig(store, config) {
  if (config.driver === 'mysql') {
    await writeMysqlStore(store, config);
  } else if (config.driver === 'sqlite') {
    await writeSqliteStore(store, config);
  } else {
    await writeLocalFileStore(store, config);
  }
}

function storeStats(store) {
  return {
    users: Object.keys(store?.users || {}).length,
    prs: Object.keys(store?.prs || {}).length,
    jobs: (store?.jobs || []).length,
    events: (store?.events || []).length,
    logs: (store?.logs || []).length
  };
}

function assertStoreStatsMigrated(sourceStore, targetStore) {
  const before = storeStats(sourceStore);
  const after = storeStats(targetStore);
  for (const key of ['users', 'prs', 'jobs', 'logs']) {
    if (before[key] !== after[key]) {
      throw new Error(`迁移校验失败：${key} 数量不一致（源 ${before[key]}，目标 ${after[key]}）。`);
    }
  }
  return { before, after };
}

async function testStorageConfig(config) {
  validateStorageConfig(config);
  if (config.driver === 'mysql') {
    await ensureMysql(config);
    const existing = await readMysqlStore(config);
    return {
      ok: true,
      message: 'MySQL 连接成功，业务表已确认可用。',
      stats: existing ? storeStats(existing) : null
    };
  }
  if (config.driver === 'sqlite') {
    const dbPath = sqlitePathFromUrl(config.databaseUrl);
    await ensureSqlite(dbPath);
    const existing = await readSqliteStore(config);
    return {
      ok: true,
      message: 'SQLite 连接成功，业务表已确认可用。',
      stats: existing ? storeStats(existing) : null
    };
  }

  await mkdir(path.dirname(config.filePath), { recursive: true });
  const testPath = `${config.filePath}.connect-test-${process.pid}-${Date.now()}.tmp`;
  await writeFile(testPath, 'ok');
  await unlink(testPath).catch(() => {});
  const existing = await readLocalFileStore(config);
  return {
    ok: true,
    message: existing
      ? '本地文件路径可读写，已检测到可读取的现有数据。'
      : '本地文件路径可读写，目标文件不存在时会自动创建。',
    stats: existing ? storeStats(existing) : null
  };
}

async function ensureStore() {
  const config = await loadStorageConfig();
  const store = await readStoreFromConfig(config);
  if (store) {
    return store;
  }
  const fresh = defaultStore();
  await saveStore(fresh);
  return fresh;
}

async function saveStore(store, explicitConfig = null) {
  const config = explicitConfig || (await loadStorageConfig());
  await writeStoreToConfig(store, config);
}

function storageForClient(config) {
  const databaseLabel = config.driver === 'mysql'
    ? `MySQL：${maskDatabaseUrl(config.databaseUrl)}`
    : `SQLite：${sqlitePathFromUrl(config.databaseUrl)}`;
  return {
    ...config,
    label: ['sqlite', 'mysql'].includes(config.driver)
      ? databaseLabel
      : `本地文件：${config.filePath}${config.compressed || config.filePath.endsWith('.gz') ? '（gzip）' : ''}`
  };
}

function maskDatabaseUrl(databaseUrl) {
  try {
    const url = new URL(databaseUrl);
    if (url.password) url.password = '******';
    return url.toString();
  } catch {
    return databaseUrl || '未配置';
  }
}

async function clientState(store) {
  if (refreshStoredPrUrls(store)) {
    await saveStore(store);
  }
  const { meta } = await readTokenInfo(store);
  return stateForClient(store, meta, storageForClient(await loadStorageConfig()));
}

function tokenFromUser(user) {
  return String(user?.bitbucketToken || user?.bitbucketAccessToken || '').trim();
}

function tokenMetaFromUser(user) {
  if (!tokenFromUser(user)) return null;
  return {
    source: 'user',
    username: user.bitbucketTokenUsername || user.username || 'unknown',
    displayName: user.bitbucketTokenDisplayName || user.displayName || user.username || 'unknown',
    updatedAt: user.bitbucketTokenUpdatedAt || null
  };
}

async function readLegacyTokenInfo() {
  try {
    const auth = JSON.parse(await readFile(TOKEN_FILE, 'utf8'));
    const token = String(auth.token || auth.accessToken || '').trim();
    if (!token) return { token: null, meta: null };
    return {
      token,
      meta: {
        source: 'skill-file',
        username: auth.username || 'unknown',
        displayName: auth.displayName || 'unknown',
        updatedAt: auth.updatedAt || null
      }
    };
  } catch {
    return { token: null, meta: null };
  }
}

async function readTokenInfo(store, actorUser = null) {
  const user = actorUser || currentUser(store);
  const userToken = tokenFromUser(user);
  if (userToken) {
    return {
      token: userToken,
      meta: tokenMetaFromUser(user)
    };
  }
  return readLegacyTokenInfo();
}

async function syncLegacyTokenFile(user) {
  const token = tokenFromUser(user);
  if (!token) return;
  await mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  await writeFile(TOKEN_FILE, `${JSON.stringify({
    token,
    username: user.bitbucketTokenUsername || user.username || 'unknown',
    displayName: user.bitbucketTokenDisplayName || user.displayName || user.username || 'unknown',
    updatedAt: user.bitbucketTokenUpdatedAt || new Date().toISOString(),
    source: 'pr-monitor-app'
  }, null, 2)}\n`, { mode: 0o600 });
}

async function clearLegacyTokenFileIfMatching(token) {
  const legacy = await readLegacyTokenInfo();
  if (legacy.token && token && legacy.token === token) {
    await unlink(TOKEN_FILE).catch(() => {});
  }
}

function addEvent(store, type, message, detail = {}) {
  const entry = {
    id: crypto.randomUUID(),
    type,
    message,
    detail,
    createdAt: new Date().toISOString()
  };
  store.events.unshift(entry);
  store.events = store.events.slice(0, 80);
  addLog(store, type, message, detail, 'system');
}

function addLog(store, type, message, detail = {}, level = 'info') {
  store.logs = store.logs || [];
  store.logs.unshift({
    id: crypto.randomUUID(),
    level,
    type,
    message,
    detail,
    userId: detail.userId || store.currentUserId || '',
    jobId: detail.jobId || '',
    prKey: detail.prKey || '',
    createdAt: new Date().toISOString()
  });
  store.logs = store.logs.slice(0, 1000);
}

function clientLogsForUser(store, user, canViewAll) {
  return (store.logs || [])
    .filter((log) => log.type !== 'review-output')
    .filter((log) => canViewAll || !log.userId || log.userId === user.id)
    .slice(0, 300);
}

function prKey(project, repo, id) {
  return `${project}/${repo}#${id}`;
}

function repoKey(project, repo) {
  return `${project}/${repo}`;
}

function legacyRepoMapping(defaultRepoPath) {
  return defaultRepoPath ? `*=${defaultRepoPath}` : '';
}

function parseRepoPathMappings(value) {
  const mappings = new Map();
  for (const line of String(value || '').split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.includes('=') ? '=' : trimmed.includes('|') ? '|' : null;
    if (!separator) continue;
    const [rawKey, ...rawPathParts] = trimmed.split(separator);
    const key = rawKey.trim();
    const repoPath = rawPathParts.join(separator).trim();
    if (key && repoPath) mappings.set(key, repoPath);
  }
  return mappings;
}

function repoPathForPr(user, project, repo, explicitPath = '') {
  if (explicitPath) return explicitPath;
  const mappings = parseRepoPathMappings(user?.repoPathMappings);
  return mappings.get(repoKey(project, repo)) || mappings.get(repo) || mappings.get('*') || '';
}

function repoPathCandidateRoots() {
  const configured = String(process.env.PR_MONITOR_REPO_ROOTS || '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  const defaults = HOME_DIR
    ? [
        path.join(HOME_DIR, 'Documents', 'VScodeProject'),
        path.join(HOME_DIR, 'Documents', 'IdeaProjects'),
        path.join(HOME_DIR, 'Documents', 'Projects'),
        path.join(HOME_DIR, 'Code'),
        path.join(HOME_DIR, 'Workspace'),
        path.join(HOME_DIR, 'workspace')
      ]
    : [];
  return [...new Set([...configured, ...defaults])];
}

async function resolveRepoPathForPr(user, project, repo, explicitPath = '') {
  const configured = repoPathForPr(user, project, repo, explicitPath);
  if (await pathExists(configured)) return configured;
  const projectRepo = repoKey(project, repo);
  for (const root of repoPathCandidateRoots()) {
    const candidates = [
      path.join(root, repo),
      path.join(root, projectRepo),
      path.join(root, project.toLowerCase(), repo),
      path.join(root, project.toUpperCase(), repo)
    ];
    for (const candidate of candidates) {
      if (await pathExists(candidate)) return candidate;
    }
  }
  return configured;
}

function recordKey(userId, displayKey) {
  return `${userId}:${displayKey}`;
}

function bitbucketBaseUrl(storeOrSettings = {}) {
  const settings = storeOrSettings.settings || storeOrSettings;
  return String(settings.baseUrl || DEFAULT_BITBUCKET_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_BITBUCKET_BASE_URL;
}

function prWebUrl(storeOrSettings, pr) {
  const project = pr.project || pr.toRef?.repository?.project?.key || 'UNKNOWN';
  const repo = pr.repo || pr.toRef?.repository?.slug || 'unknown';
  const id = pr.id;
  return `${bitbucketBaseUrl(storeOrSettings)}/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}/pull-requests/${encodeURIComponent(id)}`;
}

function refreshStoredPrUrls(store) {
  let changed = false;
  for (const pr of Object.values(store.prs || {})) {
    if (!pr.project || !pr.repo || !pr.id) continue;
    const nextUrl = prWebUrl(store, pr);
    if (pr.url !== nextUrl) {
      pr.url = nextUrl;
      changed = true;
    }
  }
  for (const job of store.jobs || []) {
    const pr = store.prs?.[job.prKey];
    const id = pr?.id || String(job.prDisplayKey || '').split('#').pop();
    const nextUrl = pr
      ? prWebUrl(store, pr)
      : (job.project && job.repo && id ? prWebUrl(store, { project: job.project, repo: job.repo, id }) : '');
    if (nextUrl && job.prUrl !== nextUrl) {
      job.prUrl = nextUrl;
      changed = true;
    }
  }
  return changed;
}

function normalizeUserInput(body, existing = {}) {
  const username = String(body.username ?? existing.username ?? '').trim();
  const displayName = String(body.displayName ?? existing.displayName ?? username).trim();
  const role = ['super-admin', 'admin', 'user'].includes(body.role) ? body.role : existing.role || 'user';
  if (!username) throw new Error('用户名不能为空。');
  if (!displayName) throw new Error('显示名称不能为空。');
  return {
    ...existing,
    username,
    displayName,
    role,
    bitbucketNames: String(body.bitbucketNames ?? existing.bitbucketNames ?? '').trim(),
    repoPathMappings: String(body.repoPathMappings ?? existing.repoPathMappings ?? '').trim()
  };
}

function userIdFromUsername(username) {
  const base = String(username || 'user')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || `user-${Date.now()}`;
  return base.slice(0, 48);
}

function currentUser(store) {
  return store.users[store.currentUserId] || Object.values(store.users)[0] || null;
}

function isSuperAdmin(user) {
  return user?.role === 'super-admin';
}

function isAdmin(user) {
  return user?.role === 'admin' || user?.role === 'super-admin';
}

function canManagePlatform(user) {
  return isAdmin(user);
}

function canManageUsers(user) {
  return isSuperAdmin(user);
}

function reviewerStatus(pr, fallback, user = null) {
  const reviewers = pr.reviewers || [];
  const names = selfReviewerNames(user);
  const own = reviewers.find((reviewer) => userMatchesSelf(reviewer.user, names));
  return own?.status || fallback || 'UNKNOWN';
}

function selfReviewerNames(user) {
  return String(user?.bitbucketNames || '')
    .split(/\n|,|;/)
    .map((name) => name.trim())
    .filter(Boolean);
}

function userMatchesSelf(user, names) {
  if (!user || !names.length) return false;
  const expected = names.map((name) => name.toLowerCase());
  const candidates = [user.name, user.displayName, user.slug, user.emailAddress]
    .filter(Boolean)
    .map((candidate) => String(candidate).trim().toLowerCase());
  return candidates.some((candidate) => expected.includes(candidate));
}

async function fetchPrActivities(store, project, repo, id, user = currentUser(store)) {
  const results = [];
  let start = 0;
  while (true) {
    const page = await bitbucketGet(
      store,
      `/rest/api/1.0/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}/pull-requests/${id}/activities`,
      { limit: 100, start },
      user
    );
    results.push(...(page.values || []));
    if (page.isLastPage) break;
    start = page.nextPageStart;
    if (start === undefined || start === null) break;
  }
  return results;
}

function reviewSignalFromActivities(activities, names) {
  const codeChanges = activities.filter((activity) => ['OPENED', 'RESCOPED'].includes(activity.action));
  const latestCodeChange = codeChanges.reduce((best, current) => (
    Number(current.createdDate || 0) > Number(best?.createdDate || 0) ? current : best
  ), null);
  const comments = activities.filter((activity) => (
    activity.action === 'COMMENTED' &&
    activity.commentAction !== 'DELETED' &&
    userMatchesSelf(activity.user || activity.comment?.author, names)
  ));
  if (!comments.length) {
    return {
      reviewedByMe: false,
      selfCommentCount: 0,
      latestSelfCommentAt: null,
      latestSelfCommentPreview: '',
      latestCodeChangeAt: latestCodeChange?.createdDate ? new Date(latestCodeChange.createdDate).toISOString() : null,
      currentReviewValid: false
    };
  }
  const latest = comments.reduce((best, current) => (
    Number(current.createdDate || 0) > Number(best.createdDate || 0) ? current : best
  ));
  const latestCommentTime = Number(latest.createdDate || 0);
  const latestCodeChangeTime = Number(latestCodeChange?.createdDate || 0);
  const currentReviewValid = latestCommentTime >= latestCodeChangeTime;
  return {
    reviewedByMe: true,
    selfCommentCount: comments.length,
    latestSelfCommentAt: latest.createdDate ? new Date(latest.createdDate).toISOString() : null,
    latestSelfCommentPreview: String(latest.comment?.text || '').slice(0, 180),
    latestCodeChangeAt: latestCodeChange?.createdDate ? new Date(latestCodeChange.createdDate).toISOString() : null,
    currentReviewValid
  };
}

async function reviewSignalForPr(store, pr, user = currentUser(store)) {
  const names = selfReviewerNames(user);
  if (!names.length) {
    return {
      reviewedByMe: false,
      selfCommentCount: 0,
      latestSelfCommentAt: null,
      latestSelfCommentPreview: '',
      latestCodeChangeAt: null,
      currentReviewValid: false,
      reviewSignalError: '未配置本人 Bitbucket 用户名或显示名'
    };
  }
  try {
    const activities = await fetchPrActivities(store, pr.project, pr.repo, pr.id, user);
    return reviewSignalFromActivities(activities, names);
  } catch (error) {
    return {
      reviewedByMe: false,
      selfCommentCount: 0,
      latestSelfCommentAt: null,
      latestSelfCommentPreview: '',
      latestCodeChangeAt: null,
      currentReviewValid: false,
      reviewSignalError: error.message
    };
  }
}

function normalizePr(pr, source, forcedStatus, localRepoPath = '', reviewSignal = {}, user = null, storeOrSettings = {}) {
  const project = pr.toRef?.repository?.project?.key || pr.project || 'UNKNOWN';
  const repo = pr.toRef?.repository?.slug || pr.repo || 'unknown';
  const id = pr.id;
  const ownerUserId = user?.id || pr.ownerUserId || 'oliver';
  const displayKey = prKey(project, repo, id);
  const key = recordKey(ownerUserId, displayKey);
  const title = pr.title || `PR #${id}`;
  const description = (pr.description || '').trim();
  const author = pr.author?.user?.displayName || pr.author?.user?.name || 'unknown';
  const fromBranch = pr.fromRef?.displayId || '';
  const toBranch = pr.toRef?.displayId || '';
  return {
    key,
    displayKey,
    ownerUserId,
    ownerDisplayName: user?.displayName || pr.ownerDisplayName || ownerUserId,
    id,
    project,
    repo,
    title,
    description,
    summary: description || title,
    author,
    state: pr.state || 'OPEN',
    reviewerStatus: reviewerStatus(pr, forcedStatus, user),
    source,
    url: prWebUrl(storeOrSettings, { project, repo, id }),
    fromBranch,
    toBranch,
    fromCommit: pr.fromRef?.latestCommit || '',
    toCommit: pr.toRef?.latestCommit || '',
    reviewers: (pr.reviewers || []).map((reviewer) => ({
      name: reviewer.user?.displayName || reviewer.user?.name || 'unknown',
      status: reviewer.status || (reviewer.approved ? 'APPROVED' : 'UNAPPROVED'),
      approved: Boolean(reviewer.approved)
    })),
    localRepoPath,
    reviewedByMe: Boolean(reviewSignal.reviewedByMe),
    selfCommentCount: reviewSignal.selfCommentCount || 0,
    latestSelfCommentAt: reviewSignal.latestSelfCommentAt || null,
    latestSelfCommentPreview: reviewSignal.latestSelfCommentPreview || '',
    latestCodeChangeAt: reviewSignal.latestCodeChangeAt || null,
    currentReviewValid: Boolean(reviewSignal.currentReviewValid),
    reviewedCommit: reviewSignal.currentReviewValid ? (pr.fromRef?.latestCommit || '') : '',
    reviewSignalError: reviewSignal.reviewSignalError || '',
    updatedAt: new Date().toISOString()
  };
}

async function bitbucketGet(store, apiPath, params = {}, actorUser = currentUser(store)) {
  return bitbucketRequest(store, 'GET', apiPath, params, null, actorUser);
}

async function bitbucketPost(store, apiPath, params = {}, body = null, actorUser = currentUser(store)) {
  return bitbucketRequest(store, 'POST', apiPath, params, body, actorUser);
}

async function bitbucketRequest(store, method, apiPath, params = {}, body = null, actorUser = currentUser(store)) {
  const { token } = await readTokenInfo(store, actorUser);
  if (!token) {
    throw new Error('当前用户未配置 Bitbucket token。请在个人设置中保存 token，或在 bitbucket-pr-review skill 本地认证文件中配置 token。');
  }
  return bitbucketRequestWithToken(store, token, method, apiPath, params, body);
}

async function bitbucketRequestWithToken(store, token, method, apiPath, params = {}, body = null) {
  const url = new URL(apiPath, store.settings.baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(method === 'GET' ? {} : { 'X-Atlassian-Token': 'no-check' }),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  const text = await response.text();
  if (!text && response.ok) return {};
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Bitbucket returned ${response.status}: ${text.slice(0, 160)}`);
  }
  if (!response.ok) {
    throw new Error(data.errors?.[0]?.message || `Bitbucket returned ${response.status}`);
  }
  return data;
}

async function testBitbucketToken(store, token) {
  if (!String(token || '').trim()) {
    throw new Error('请先输入或保存 Bitbucket token。');
  }
  await bitbucketRequestWithToken(store, String(token).trim(), 'GET', '/rest/api/1.0/dashboard/pull-requests', {
    state: 'OPEN',
    role: 'REVIEWER',
    limit: 1
  });
  return {
    ok: true,
    message: 'Bitbucket token 测试通过，已能读取当前账号的 PR 看板。'
  };
}

async function checkRuntimeEnvironment(store = defaultStore(), overrides = {}) {
  const checks = [];
  const configuredCodexPath = String(overrides.codexExecutablePath ?? store.settings?.codexExecutablePath ?? '').trim();
  try {
    const codexPath = await resolveCodexExecutable(configuredCodexPath);
    checks.push({
      id: 'codex',
      label: 'Codex CLI',
      ok: true,
      message: configuredCodexPath ? `已通过手动路径找到：${codexPath}` : `已找到：${codexPath}`,
      path: codexPath
    });
  } catch (error) {
    checks.push({
      id: 'codex',
      label: 'Codex CLI',
      ok: false,
      message: configuredCodexPath ? `手动路径不可用：${configuredCodexPath}。${error.message}` : error.message
    });
  }

  const skillPath = path.join(SKILL_DIR, 'SKILL.md');
  try {
    await access(skillPath, constants.R_OK);
    checks.push({
      id: 'review-skill',
      label: 'bitbucket-pr-review skill',
      ok: true,
      message: `已找到：${skillPath}`,
      path: skillPath
    });
  } catch {
    checks.push({
      id: 'review-skill',
      label: 'bitbucket-pr-review skill',
      ok: false,
      message: `未找到或不可读取：${skillPath}`
    });
  }

  const roots = [];
  for (const root of repoPathCandidateRoots()) {
    roots.push({
      path: root,
      exists: await pathExists(root)
    });
  }
  checks.push({
    id: 'repo-roots',
    label: '仓库搜索目录',
    ok: roots.some((root) => root.exists),
    message: roots.some((root) => root.exists)
      ? `已检测到 ${roots.filter((root) => root.exists).length} 个可读搜索目录。`
      : '未检测到默认仓库搜索目录，可在初始化时填写仓库路径映射。',
    roots
  });

  return {
    ok: checks.every((check) => check.ok),
    checks
  };
}

async function fetchDashboardPrs(store, participantStatus) {
  const results = [];
  let start = 0;
  while (true) {
    const page = await bitbucketGet(store, '/rest/api/1.0/dashboard/pull-requests', {
      state: 'OPEN',
      role: 'REVIEWER',
      participantStatus,
      limit: 100,
      start
    });
    results.push(...(page.values || []));
    if (page.isLastPage) break;
    start = page.nextPageStart;
    if (start === undefined || start === null) break;
  }
  return results;
}

async function syncPrs({ triggerReview = false, reason = 'manual' } = {}) {
  const store = await ensureStore();
  const user = currentUser(store);
  const awaitingRaw = await fetchDashboardPrs(store, 'UNAPPROVED');
  const reviewedRaw = await fetchDashboardPrs(store, 'APPROVED');
  const now = new Date().toISOString();
  const newAwaiting = [];
  const seenAwaiting = new Set();
  const seenReviewed = new Set();

  for (const raw of awaitingRaw) {
    const baseProject = raw.toRef?.repository?.project?.key || raw.project || 'UNKNOWN';
    const baseRepo = raw.toRef?.repository?.slug || raw.repo || 'unknown';
    const mappedRepoPath = await resolveRepoPathForPr(user, baseProject, baseRepo);
    const basic = normalizePr(raw, 'dashboard', 'UNAPPROVED', mappedRepoPath, {}, user, store);
    const signal = await reviewSignalForPr(store, basic, user);
    const normalized = normalizePr(raw, 'dashboard', 'UNAPPROVED', mappedRepoPath, signal, user, store);
    const previous = store.prs[normalized.key];
    const platformReviewValid = Boolean(
      (previous?.platformReviewedCommit && previous.platformReviewedCommit === normalized.fromCommit) ||
      store.jobs.some((job) => job.prKey === normalized.key && job.status === 'done' && job.reviewedCommit === normalized.fromCommit)
    );
    const reviewedCurrentCommit = Boolean(previous?.reviewedCommit && previous.reviewedCommit === normalized.fromCommit);
    const effectiveCurrentReviewValid = Boolean(normalized.currentReviewValid || reviewedCurrentCommit || platformReviewValid);
    const statusBucket = effectiveCurrentReviewValid ? 'reviewed-unapproved' : 'awaiting';
    seenAwaiting.add(normalized.key);
    store.prs[normalized.key] = {
      ...previous,
      ...normalized,
      statusBucket,
      reviewedByMe: Boolean(normalized.reviewedByMe || previous?.reviewedByMe || platformReviewValid),
      currentReviewValid: effectiveCurrentReviewValid,
      reviewedCommit: effectiveCurrentReviewValid ? (normalized.reviewedCommit || previous?.reviewedCommit || normalized.fromCommit) : '',
      platformReviewedAt: platformReviewValid ? previous?.platformReviewedAt || now : '',
      platformReviewedCommit: platformReviewValid ? normalized.fromCommit : '',
      firstSeenAt: previous?.firstSeenAt || now,
      lastSeenAt: now
    };
    if (statusBucket === 'awaiting' && (!previous || previous.statusBucket !== 'awaiting')) {
      newAwaiting.push(store.prs[normalized.key]);
    }
  }

  for (const raw of reviewedRaw) {
    const baseProject = raw.toRef?.repository?.project?.key || raw.project || 'UNKNOWN';
    const baseRepo = raw.toRef?.repository?.slug || raw.repo || 'unknown';
    const mappedRepoPath = await resolveRepoPathForPr(user, baseProject, baseRepo);
    const basic = normalizePr(raw, 'dashboard', 'APPROVED', mappedRepoPath, {}, user, store);
    const signal = await reviewSignalForPr(store, basic, user);
    const normalized = normalizePr(raw, 'dashboard', 'APPROVED', mappedRepoPath, signal, user, store);
    seenReviewed.add(normalized.key);
    const previous = store.prs[normalized.key];
    store.prs[normalized.key] = {
      ...previous,
      ...normalized,
      statusBucket: 'reviewed',
      reviewedByMe: true,
      currentReviewValid: true,
      reviewedCommit: normalized.fromCommit,
      platformReviewedAt: previous?.platformReviewedAt || '',
      platformReviewedCommit: previous?.platformReviewedCommit === normalized.fromCommit ? previous.platformReviewedCommit : '',
      firstSeenAt: previous?.firstSeenAt || now,
      lastSeenAt: now
    };
  }

  for (const pr of Object.values(store.prs)) {
    if (
      pr.source === 'dashboard' &&
      pr.ownerUserId === user.id &&
      ['awaiting', 'reviewed', 'reviewed-unapproved'].includes(pr.statusBucket) &&
      !seenAwaiting.has(pr.key) &&
      !seenReviewed.has(pr.key)
    ) {
      pr.statusBucket = 'archived';
      pr.reviewerStatus = 'NOT_IN_DASHBOARD';
      pr.updatedAt = now;
    }
  }

  store.scheduler.lastRunAt = now;
  store.scheduler.lastError = null;
  const userPrs = Object.values(store.prs).filter((pr) => pr.ownerUserId === user.id);
  const awaitingCount = userPrs.filter((pr) => pr.statusBucket === 'awaiting').length;
  const reviewedUnapprovedCount = userPrs.filter((pr) => pr.statusBucket === 'reviewed-unapproved').length;
  addEvent(store, 'sync', `${user.displayName} 同步完成：待处理 ${awaitingCount} 个，已评论未 approve ${reviewedUnapprovedCount} 个，已 approve ${reviewedRaw.length} 个`, {
    userId: user.id,
    awaiting: awaitingCount,
    reviewedUnapproved: reviewedUnapprovedCount,
    reviewed: reviewedRaw.length,
    reason
  });

  if (triggerReview && store.settings.autoReviewEnabled) {
    for (const pr of newAwaiting) {
      createReviewJob(store, pr, 'scheduled-new-pr');
    }
  }

  await saveStore(store);
  if (triggerReview && store.settings.autoReviewEnabled) {
    await runQueuedJobs();
  }
  return store;
}

function createReviewJob(store, pr, reason = 'manual') {
  const existing = store.jobs.find((job) => (
    job.prKey === pr.key &&
    job.ownerUserId === pr.ownerUserId &&
    (['queued', 'running'].includes(job.status) || (job.status === 'done' && job.reviewedCommit === pr.fromCommit))
  ));
  if (existing) return existing;

  const job = {
    id: crypto.randomUUID(),
    ownerUserId: pr.ownerUserId,
    ownerDisplayName: pr.ownerDisplayName,
    prKey: pr.key,
    prDisplayKey: pr.displayKey,
    prUrl: pr.url,
    project: pr.project,
    repo: pr.repo,
    title: pr.title,
    status: 'queued',
    reason,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    targetCommit: pr.fromCommit || '',
    reviewedCommit: '',
    reviewResult: '',
    log: '',
    commandPreview: ''
  };
  store.jobs.unshift(job);
  store.jobs = store.jobs.slice(0, 100);
  addEvent(store, 'review-job', `已创建评审任务：${pr.displayKey}`, { jobId: job.id, reason, userId: pr.ownerUserId });
  return job;
}

async function pathExists(candidate) {
  if (!candidate) return false;
  try {
    await access(candidate, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function buildReviewPrompt(pr, settings) {
  return [
    `[$bitbucket-pr-review](${path.join(SKILL_DIR, 'SKILL.md')})`,
    '请评审这个 Bitbucket PR，并把确认的问题以中文 Bitbucket inline comment 发布到 PR 上。',
    '用户已经在 PR 监控平台中启用自动评审，确认允许复用本地已保存的 Bitbucket token。',
    `PR: ${pr.url}`,
    `本地仓库目录: ${pr.localRepoPath || '未配置'}`,
    '要求：只评论确认的问题；评论带 [P0]/[P1]/[P2]；不要发布猜测性或纯风格评论；最终输出评审摘要。',
    '最终输出最后一行必须是 REVIEW_RESULT: COMMENTS_POSTED、REVIEW_RESULT: NO_FINDINGS 或 REVIEW_RESULT: FAILED。'
  ].join('\n');
}

function logText(current, text) {
  return `${current}${text}`.slice(-20000);
}

function outputPathForJob(jobId) {
  return path.join(DATA_DIR, 'review-outputs', `${jobId}.md`);
}

function logHasBlockingAutomationFailure(log) {
  const lines = String(log || '').split('\n');
  return lines.some((line) => (
    /approval policy is Never/i.test(line) ||
    /reject command/i.test(line) ||
    /permission denied/i.test(line)
  ));
}

function finalMessageIndicatesSuccess(message) {
  const text = String(message || '');
  return (
    /REVIEW_RESULT:\s*(COMMENTS_POSTED|NO_FINDINGS)/i.test(text) ||
    /(已|已经).{0,12}(发布|提交|添加).{0,12}(inline\s*)?(comment|评论)/i.test(text) ||
    /(未发现|没有发现|无).{0,12}(确认的问题|问题|缺陷|bug)/i.test(text) ||
    /no (confirmed )?(findings|issues|bugs)/i.test(text)
  );
}

function extractEventText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(extractEventText).filter(Boolean).join('');
  }
  if (typeof value !== 'object') return '';
  for (const key of ['delta', 'text', 'content', 'message', 'output', 'summary']) {
    const text = extractEventText(value[key]);
    if (text) return text;
  }
  return '';
}

function formatCodexEvent(line) {
  if (!line.trim()) return '';
  try {
    const event = JSON.parse(line);
    const type = event.type || event.event || event.kind || 'event';
    const text = extractEventText(event);
    if (text) return text.endsWith('\n') ? text : `${text}\n`;
    if (type.includes('turn_started') || type.includes('task_started')) return 'AI 开始分析...\n';
    if (type.includes('exec_command_begin')) return `执行命令：${event.command || event.cmd || 'shell'}\n`;
    if (type.includes('exec_command_end')) return `命令结束：${event.exit_code ?? event.exitCode ?? 'unknown'}\n`;
    if (type.includes('error')) return `错误：${event.error || event.message || JSON.stringify(event)}\n`;
    return `[${type}]\n`;
  } catch {
    return `${line}\n`;
  }
}

async function findMatchingCodexPids(job) {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command=']);
    return stdout
      .split('\n')
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        return match ? { pid: Number(match[1]), command: match[2] } : null;
      })
      .filter(Boolean)
      .filter(({ pid, command }) => {
        return (
          pid !== process.pid &&
          command.includes('codex exec') &&
          (command.includes(job.prUrl) || command.includes(job.prDisplayKey || job.prKey))
        );
      })
      .map(({ pid }) => pid);
  } catch {
    return [];
  }
}

function processExists(pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function reconcileStaleRunningJobs(store, { graceMs = 60_000 } = {}) {
  let changed = false;
  const now = Date.now();
  for (const job of store.jobs || []) {
    if (job.status !== 'running') continue;
    if (runningReviewProcesses.has(job.id)) continue;
    if (processExists(job.childPid)) continue;
    const pids = await findMatchingCodexPids(job);
    if (pids.length) continue;
    const startedAt = Date.parse(job.startedAt || job.createdAt || 0) || 0;
    if (startedAt && now - startedAt < graceMs) continue;
    job.status = 'failed';
    job.exitCode = null;
    job.finishedAt = new Date().toISOString();
    job.reviewResult = 'failed';
    job.log = `${job.log || ''}\n服务重启或进程退出后未找到对应的 Codex 执行进程，任务已标记为失败。`.slice(-20000);
    delete job.childPid;
    addEvent(store, 'review-stale', `评审任务进程已丢失：${job.prDisplayKey || job.prKey}`, { jobId: job.id });
    changed = true;
  }
  return changed;
}

async function stopReviewProcess(job) {
  const tracked = runningReviewProcesses.get(job.id);
  const pids = new Set();
  if (tracked?.pid) pids.add(tracked.pid);
  if (job.childPid) pids.add(job.childPid);
  for (const pid of await findMatchingCodexPids(job)) pids.add(pid);

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  runningReviewProcesses.delete(job.id);
}

async function runReviewJob(jobId) {
  const store = await ensureStore();
  const job = store.jobs.find((item) => item.id === jobId);
  if (!job) throw new Error('Review job not found.');
  if (job.status === 'running') return job;
  const actor = currentUser(store);
  if (!isAdmin(actor) && job.ownerUserId !== actor.id) {
    throw new Error('不能执行其他用户的 review 任务。');
  }
  const pr = store.prs[job.prKey];
  if (!pr) throw new Error('PR not found for review job.');
  pr.url = prWebUrl(store, pr);
  job.prUrl = pr.url;
  if (job.status === 'done' && job.reviewedCommit === pr.fromCommit) {
    return job;
  }
  if (!store.settings.dangerousBypass) {
    job.status = 'blocked';
    job.finishedAt = new Date().toISOString();
    job.reviewResult = 'blocked';
    job.log = '自动 review 需要 Codex 执行读取仓库、查询 PR diff、发布 Bitbucket inline comment 等命令。当前未开启“允许 Codex 自动执行评论所需命令”，任务已阻塞，未尝试发布评论。';
    addEvent(store, 'review-blocked', `评审任务缺少自动执行权限：${job.prDisplayKey || job.prKey}`, { jobId: job.id });
    await saveStore(store);
    return job;
  }
  const owner = store.users[job.ownerUserId] || currentUser(store);
  const ownerTokenInfo = await readTokenInfo(store, owner);
  if (!ownerTokenInfo.token) {
    job.status = 'blocked';
    job.finishedAt = new Date().toISOString();
    job.reviewResult = 'blocked';
    job.log = '缺少 Bitbucket token。请在个人设置中配置 token 后重新执行任务。';
    addEvent(store, 'review-blocked', `评审任务缺少 Bitbucket token：${job.prDisplayKey || job.prKey}`, {
      jobId: job.id,
      prKey: job.prKey,
      userId: job.ownerUserId
    });
    await saveStore(store);
    return job;
  }
  await syncLegacyTokenFile(owner);

  const repoPath = await resolveRepoPathForPr(owner, pr.project, pr.repo, pr.localRepoPath);
  if (repoPath && repoPath !== pr.localRepoPath) {
    pr.localRepoPath = repoPath;
    pr.updatedAt = new Date().toISOString();
  }
  if (!(await pathExists(repoPath))) {
    job.status = 'blocked';
    job.finishedAt = new Date().toISOString();
    job.reviewResult = 'blocked';
    job.log = '缺少可读取的本地仓库目录。请在设置或导入 PR 时配置 local repo path。';
    addEvent(store, 'review-blocked', `评审任务缺少本地仓库目录：${job.prDisplayKey || job.prKey}`, {
      jobId: job.id,
      prKey: job.prKey,
      userId: job.ownerUserId
    });
    await saveStore(store);
    return job;
  }

  const prompt = buildReviewPrompt({ ...pr, localRepoPath: repoPath }, store.settings);
  const outputPath = outputPathForJob(job.id);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const args = [
    'exec',
    '--json',
    '--output-last-message',
    outputPath,
    '--skip-git-repo-check',
    '-C',
    repoPath,
    '--add-dir',
    SKILL_DIR
  ];
  if (store.settings.dangerousBypass) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }
  args.push(prompt);

  job.status = 'running';
  job.startedAt = new Date().toISOString();
  job.finishedAt = null;
  job.exitCode = null;
  job.targetCommit = pr.fromCommit || '';
  job.reviewedCommit = '';
  job.reviewResult = '';
  job.beforeSelfCommentCount = pr.selfCommentCount || 0;
  let codexCommand = '';
  try {
    codexCommand = await resolveCodexExecutable(store.settings.codexExecutablePath);
  } catch (error) {
    job.status = 'failed';
    job.finishedAt = new Date().toISOString();
    job.reviewResult = 'failed';
    job.log = `评审任务启动失败：${error.message}`;
    addLog(store, 'review-failed', `评审任务启动失败：${job.prDisplayKey || job.prKey}`, {
      jobId: job.id,
      prKey: job.prKey,
      userId: job.ownerUserId,
      error: error.message
    }, 'error');
    addEvent(store, 'review-failed', `评审任务启动失败：${job.prDisplayKey || job.prKey}`, { jobId: job.id });
    await saveStore(store);
    return job;
  }
  job.commandPreview = `${codexCommand} ${args.map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg)).join(' ')}`;
  job.log = '评审任务已启动，正在后台执行。';
  job.liveLogUpdatedAt = new Date().toISOString();
  addEvent(store, 'review-started', `评审任务开始执行：${job.prDisplayKey || job.prKey}`, {
    jobId: job.id,
    prKey: job.prKey,
    userId: job.ownerUserId
  });
  await saveStore(store);

  let logBuffer = `${job.log}\n`;
  let stdoutRemainder = '';
  let flushTimer = null;
  let childErrorHandled = false;

  async function flushLiveLog() {
    flushTimer = null;
    const latest = await ensureStore();
    const latestJob = latest.jobs.find((item) => item.id === job.id);
    if (!latestJob || latestJob.status !== 'running') return;
    latestJob.log = logBuffer;
    latestJob.liveLogUpdatedAt = new Date().toISOString();
    latestJob.childPid = child.pid;
    await saveStore(latest);
  }

  function scheduleLiveLogFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushLiveLog().catch(() => {});
    }, 700);
  }

  async function handleChildError(error) {
    if (childErrorHandled) return;
    childErrorHandled = true;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    runningReviewProcesses.delete(job.id);
    const latest = await ensureStore();
    const latestJob = latest.jobs.find((item) => item.id === job.id);
    if (!latestJob) return;
    latestJob.status = 'failed';
    latestJob.finishedAt = new Date().toISOString();
    latestJob.reviewResult = 'failed';
    latestJob.log = logText(logBuffer, `评审任务启动失败：${error.message}\n`);
    delete latestJob.childPid;
    addLog(latest, 'review-failed', `评审任务启动失败：${latestJob.prDisplayKey || latestJob.prKey}`, {
      jobId: latestJob.id,
      prKey: latestJob.prKey,
      userId: latestJob.ownerUserId,
      error: error.message
    }, 'error');
    addEvent(latest, 'review-failed', `评审任务启动失败：${latestJob.prDisplayKey || latestJob.prKey}`, { jobId: latestJob.id });
    await saveStore(latest);
  }

  let child;
  try {
    child = spawn(codexCommand, args, {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: expandedPath() },
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(codexCommand)
    });
  } catch (error) {
    await handleChildError(error);
    return (await ensureStore()).jobs.find((item) => item.id === job.id) || job;
  }
  child.on('error', (error) => {
    handleChildError(error).catch(() => {});
  });
  runningReviewProcesses.set(job.id, child);
  child.stdout?.on('data', (chunk) => {
    stdoutRemainder += chunk.toString();
    const lines = stdoutRemainder.split(/\n/);
    stdoutRemainder = lines.pop() || '';
    for (const line of lines) {
      logBuffer = logText(logBuffer, formatCodexEvent(line));
    }
    scheduleLiveLogFlush();
  });
  child.stderr?.on('data', (chunk) => {
    logBuffer = logText(logBuffer, chunk.toString());
    scheduleLiveLogFlush();
  });
  job.childPid = child.pid;
  job.log = logText(job.log, `\nCodex 进程已启动，PID: ${child.pid || 'unknown'}。\n`);
  logBuffer = `${job.log}\n`;
  await saveStore(store);

  child.on('close', async (code, signal) => {
    try {
      if (childErrorHandled) return;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      runningReviewProcesses.delete(job.id);
      const latest = await ensureStore();
      const latestJob = latest.jobs.find((item) => item.id === job.id);
      if (!latestJob) return;
      if (stdoutRemainder) {
        logBuffer = logText(logBuffer, formatCodexEvent(stdoutRemainder));
        stdoutRemainder = '';
      }
      const finalMessage = String(await readFile(outputPath, 'utf8').catch(() => '')).trim();
      if (finalMessage) {
        logBuffer = logText(logBuffer, `\n最终输出：\n${finalMessage}\n`);
      }

      const latestPr = latest.prs[latestJob.prKey];
      const latestOwner = latest.users[latestJob.ownerUserId] || currentUser(latest);
      let reviewSignal = null;
      if (latestPr) {
        reviewSignal = await reviewSignalForPr(latest, latestPr, latestOwner);
        if (!reviewSignal.reviewSignalError) {
          Object.assign(latestPr, {
            reviewedByMe: reviewSignal.reviewedByMe,
            selfCommentCount: reviewSignal.selfCommentCount,
            latestSelfCommentAt: reviewSignal.latestSelfCommentAt,
            latestSelfCommentPreview: reviewSignal.latestSelfCommentPreview,
            latestCodeChangeAt: reviewSignal.latestCodeChangeAt,
            currentReviewValid: reviewSignal.currentReviewValid,
            reviewSignalError: ''
          });
        } else {
          latestPr.reviewSignalError = reviewSignal.reviewSignalError;
          logBuffer = logText(logBuffer, `评审结束后同步 PR 评论信号失败：${reviewSignal.reviewSignalError}\n`);
        }
      }

      const commentsAdded = Number(reviewSignal?.selfCommentCount || 0) > Number(latestJob.beforeSelfCommentCount || 0);
      const noReviewOutput = logBuffer.includes('Reading additional input from stdin') && !finalMessage && !commentsAdded;
      const finalMessageSuccess = finalMessageIndicatesSuccess(finalMessage);
      const automationFailure = !finalMessageSuccess && logHasBlockingAutomationFailure(logBuffer);
      const reviewSucceeded = code === 0 && !signal && !automationFailure && !noReviewOutput && (commentsAdded || finalMessageSuccess);
      latestJob.exitCode = code;
      latestJob.status = reviewSucceeded ? 'done' : 'failed';
      latestJob.finishedAt = new Date().toISOString();
      latestJob.reviewResult = reviewSucceeded ? (commentsAdded ? 'comments-posted' : 'no-findings') : 'failed';
      if (reviewSucceeded && latestPr) {
        latestJob.reviewedCommit = latestPr.fromCommit || latestJob.targetCommit || '';
        latestPr.platformReviewedAt = latestJob.finishedAt;
        latestPr.platformReviewedCommit = latestJob.reviewedCommit;
        latestPr.reviewedCommit = latestJob.reviewedCommit;
        latestPr.statusBucket = latestPr.reviewerStatus === 'APPROVED' ? 'reviewed' : 'reviewed-unapproved';
        latestPr.updatedAt = latestJob.finishedAt;
      }
      if (noReviewOutput) {
        logBuffer = logText(logBuffer, 'Codex 一直在等待 stdin，未产生有效 review 输出。已按失败处理，请重新执行任务。\n');
      }
      if (automationFailure) {
        logBuffer = logText(logBuffer, 'Codex 执行过程中出现权限/认证拦截，未确认完成 PR 评论。已按失败处理。可在平台设置中启用“允许 Codex 自动执行评论所需命令”后重试。\n');
      }
      if (!reviewSucceeded && code === 0 && !automationFailure && !noReviewOutput) {
        logBuffer = logText(logBuffer, '任务虽然正常退出，但没有检测到新增本人评论，也没有明确的无问题结论。已按失败处理，避免误判为已评审。\n');
      }
      latestJob.log = signal ? `${logBuffer}\n任务已被终止：${signal}`.slice(-20000) : logBuffer;
      delete latestJob.childPid;
      addEvent(latest, latestJob.status === 'done' ? 'review-done' : 'review-failed', `评审任务结束：${latestJob.prDisplayKey || latestJob.prKey}`, {
        jobId: latestJob.id,
        exitCode: code,
        signal
      });
      await saveStore(latest);
    } catch (error) {
      const latest = await ensureStore();
      const latestJob = latest.jobs.find((item) => item.id === job.id);
      if (!latestJob) return;
      latestJob.status = 'failed';
      latestJob.finishedAt = new Date().toISOString();
      latestJob.reviewResult = 'failed';
      latestJob.log = logText(logBuffer, `评审任务结算失败：${error.message}\n`);
      delete latestJob.childPid;
      addLog(latest, 'review-failed', `评审任务结算失败：${latestJob.prDisplayKey || latestJob.prKey}`, {
        jobId: latestJob.id,
        prKey: latestJob.prKey,
        userId: latestJob.ownerUserId,
        error: error.message
      }, 'error');
      await saveStore(latest);
    }
  });

  return job;
}

async function runQueuedJobs() {
  const store = await ensureStore();
  const queued = store.jobs.filter((job) => job.status === 'queued');
  for (const job of queued) {
    await runReviewJob(job.id);
  }
}

async function deleteReviewJob(jobId) {
  const store = await ensureStore();
  const job = store.jobs.find((item) => item.id === jobId);
  if (!job) throw new Error('Review job not found.');
  const actor = currentUser(store);
  if (!isAdmin(actor) && job.ownerUserId !== actor.id) {
    throw new Error('不能删除其他用户的 review 任务。');
  }
  if (job.status === 'running') {
    await stopReviewProcess(job);
  }
  store.jobs = store.jobs.filter((item) => item.id !== jobId);
  addEvent(store, 'review-delete', `已删除评审任务：${job.prDisplayKey || job.prKey}`, { jobId });
  await saveStore(store);
  return { job, store };
}

async function approvePr(prKeyValue) {
  const store = await ensureStore();
  const pr = store.prs[prKeyValue];
  if (!pr) throw new Error('PR not found.');
  const actor = currentUser(store);
  if (!isAdmin(actor) && pr.ownerUserId !== actor.id) {
    throw new Error('不能 approve 其他用户的 PR。');
  }
  await bitbucketPost(
    store,
    `/rest/api/1.0/projects/${encodeURIComponent(pr.project)}/repos/${encodeURIComponent(pr.repo)}/pull-requests/${pr.id}/approve`
  );
  pr.statusBucket = 'reviewed';
  pr.reviewerStatus = 'APPROVED';
  pr.reviewedByMe = true;
  pr.currentReviewValid = true;
  pr.reviewedCommit = pr.fromCommit;
  pr.approvedAt = new Date().toISOString();
  pr.updatedAt = pr.approvedAt;
  addEvent(store, 'approve', `已 approve PR：${pr.displayKey || pr.key}`, { prKey: pr.key, userId: actor.id });
  await saveStore(store);
  return { pr, store };
}

async function updatePrLocalRepoPath(prKeyValue, localRepoPath, saveAsMapping = false) {
  const store = await ensureStore();
  const pr = store.prs[prKeyValue];
  if (!pr) throw new Error('PR not found.');
  const actor = currentUser(store);
  if (!isAdmin(actor) && pr.ownerUserId !== actor.id) {
    throw new Error('不能修改其他用户的 PR 仓库路径。');
  }
  const normalizedPath = String(localRepoPath || '').trim();
  if (!normalizedPath) {
    throw new Error('本地仓库路径不能为空。');
  }
  if (!(await pathExists(normalizedPath))) {
    throw new Error('本地仓库路径不可读取，请确认目录存在。');
  }
  pr.localRepoPath = normalizedPath;
  pr.updatedAt = new Date().toISOString();
  if (saveAsMapping) {
    const owner = store.users[pr.ownerUserId] || actor;
    const existing = parseRepoPathMappings(owner.repoPathMappings);
    existing.set(repoKey(pr.project, pr.repo), normalizedPath);
    owner.repoPathMappings = Array.from(existing.entries())
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    store.users[owner.id] = owner;
  }
  addEvent(store, 'repo-path', `已配置 PR 本地仓库路径：${pr.displayKey || pr.key}`, {
    prKey: pr.key,
    userId: actor.id,
    localRepoPath: normalizedPath,
    saveAsMapping
  });
  await saveStore(store);
  return { pr, store };
}

function parsePrUrl(input) {
  const match = input.match(/\/projects\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)/i);
  if (!match) return null;
  return {
    project: decodeURIComponent(match[1]),
    repo: decodeURIComponent(match[2]),
    id: match[3]
  };
}

async function importPr(input, localRepoPath) {
  const parsed = parsePrUrl(input);
  if (!parsed) throw new Error('无法解析 PR URL，请使用 /projects/<PROJECT>/repos/<REPO>/pull-requests/<ID> 格式。');
  const store = await ensureStore();
  const raw = await bitbucketGet(
    store,
    `/rest/api/1.0/projects/${encodeURIComponent(parsed.project)}/repos/${encodeURIComponent(parsed.repo)}/pull-requests/${parsed.id}`
  );
  const user = currentUser(store);
  const normalized = normalizePr(
    raw,
    'imported',
    undefined,
    await resolveRepoPathForPr(user, raw.toRef?.repository?.project?.key || parsed.project, raw.toRef?.repository?.slug || parsed.repo, localRepoPath),
    {},
    user,
    store
  );
  const previous = store.prs[normalized.key];
  store.prs[normalized.key] = {
    ...previous,
    ...normalized,
    statusBucket: previous?.statusBucket || 'imported',
    importedAt: previous?.importedAt || new Date().toISOString(),
    firstSeenAt: previous?.firstSeenAt || new Date().toISOString()
  };
  addEvent(store, 'import', `已导入 PR：${normalized.displayKey}`, { url: normalized.url, userId: user.id });
  await saveStore(store);
  return store.prs[normalized.key];
}

function userForClient(user) {
  if (!user) return null;
  const {
    bitbucketToken,
    bitbucketAccessToken,
    bitbucketTokenUsername,
    bitbucketTokenDisplayName,
    ...safeUser
  } = user;
  return {
    ...safeUser,
    hasBitbucketToken: Boolean(bitbucketToken || bitbucketAccessToken),
    bitbucketTokenUpdatedAt: user.bitbucketTokenUpdatedAt || null
  };
}

function stateForClient(store, tokenMeta, storage) {
  const user = currentUser(store);
  if (!store.initialized || !user) {
    return {
      initialized: false,
      settings: store.settings,
      storage,
      users: [],
      currentUser: null,
      permissions: {
        canManageStorage: false,
        canManagePlatform: false,
        canManageUsers: false,
        canViewAllUsers: false
      },
      scheduler: store.scheduler,
      token: tokenMeta,
      stats: { awaiting: 0, reviewedUnapproved: 0, reviewed: 0, approved: 0, imported: 0, queued: 0, running: 0 },
      prs: [],
      jobs: [],
      events: [],
      logs: []
    };
  }
  const canViewAll = isSuperAdmin(user);
  const prs = Object.values(store.prs)
    .filter((pr) => canViewAll || pr.ownerUserId === user.id)
    .sort((a, b) => (b.lastSeenAt || b.importedAt || '').localeCompare(a.lastSeenAt || a.importedAt || ''));
  const jobs = store.jobs.filter((job) => canViewAll || job.ownerUserId === user.id);
  const activeReviewJobs = jobs.filter((job) => ['queued', 'running'].includes(job.status));
  const activeReviewJobByPrKey = new Map(activeReviewJobs.map((job) => [job.prKey, job]));
  const latestReviewJobByPrKey = new Map();
  for (const job of jobs) {
    if (!latestReviewJobByPrKey.has(job.prKey)) {
      latestReviewJobByPrKey.set(job.prKey, job);
    }
  }
  const prsForClient = prs.map((pr) => {
    const activeJob = activeReviewJobByPrKey.get(pr.key);
    const latestJob = latestReviewJobByPrKey.get(pr.key);
    const platformReviewCurrent = Boolean(
      (pr.platformReviewedCommit && pr.platformReviewedCommit === pr.fromCommit) ||
      (latestJob?.status === 'done' && latestJob.reviewedCommit === pr.fromCommit)
    );
    const approvedCurrent = pr.reviewerStatus === 'APPROVED';
    const effectiveCurrentReviewValid = Boolean(pr.currentReviewValid || platformReviewCurrent || approvedCurrent);
    return {
      ...pr,
      reviewedByMe: Boolean(pr.reviewedByMe || platformReviewCurrent || approvedCurrent),
      currentReviewValid: effectiveCurrentReviewValid,
      reviewedCommit: effectiveCurrentReviewValid ? (pr.reviewedCommit || pr.fromCommit || '') : '',
      platformReviewCurrent,
      activeReviewJob: activeJob
        ? {
            id: activeJob.id,
            status: activeJob.status,
            createdAt: activeJob.createdAt,
            startedAt: activeJob.startedAt
          }
        : null,
      latestReviewJob: latestJob
        ? {
            id: latestJob.id,
            status: latestJob.status,
            reviewResult: latestJob.reviewResult || '',
            reviewedCommit: latestJob.reviewedCommit || '',
            targetCommit: latestJob.targetCommit || '',
            createdAt: latestJob.createdAt,
            finishedAt: latestJob.finishedAt
          }
        : null
    };
  });
  const actionableAwaitingPrs = prsForClient.filter((pr) => (
    pr.statusBucket === 'awaiting' &&
    !pr.activeReviewJob &&
    !(pr.latestReviewJob?.status === 'done' && pr.latestReviewJob.reviewedCommit === pr.fromCommit)
  ));
  return {
    settings: store.settings,
    storage,
    initialized: true,
    users: Object.values(store.users).map(({ id, username, displayName, role, bitbucketNames, repoPathMappings }) => ({
      id,
      username,
      displayName,
      role,
      bitbucketNames: canManageUsers(user) ? bitbucketNames || '' : undefined,
      repoPathMappings: canManageUsers(user) ? repoPathMappings || '' : undefined
    })),
    currentUser: userForClient(user),
    permissions: {
      canManageStorage: canManagePlatform(user),
      canManagePlatform: canManagePlatform(user),
      canManageUsers: canManageUsers(user),
      canViewAllUsers: canViewAll
    },
    scheduler: store.scheduler,
    token: tokenMeta,
    stats: {
      awaiting: actionableAwaitingPrs.length,
      reviewedUnapproved: prsForClient.filter((pr) => pr.statusBucket === 'reviewed-unapproved').length,
      reviewed: prsForClient.filter((pr) => ['reviewed', 'reviewed-unapproved'].includes(pr.statusBucket)).length,
      approved: prsForClient.filter((pr) => pr.statusBucket === 'reviewed').length,
      imported: prsForClient.filter((pr) => pr.source === 'imported').length,
      queued: jobs.filter((job) => job.status === 'queued').length,
      running: jobs.filter((job) => job.status === 'running').length
    },
    prs: prsForClient,
    jobs,
    events: store.events,
    logs: clientLogsForUser(store, user, canViewAll)
  };
}

function cleanLogForStorage(value) {
  return String(value || '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .join('\n');
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function sendStatic(response, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const fullPath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  try {
    const data = await readFile(fullPath);
    const ext = path.extname(fullPath);
    const type = ext === '.css'
      ? 'text/css'
      : ext === '.js'
        ? 'text/javascript'
        : ext === '.svg'
          ? 'image/svg+xml'
          : 'text/html';
    response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
}

async function refreshScheduler() {
  const store = await ensureStore();
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  if (!store.settings.schedulerEnabled) {
    store.scheduler.running = false;
    store.scheduler.nextRunAt = null;
    await saveStore(store);
    return;
  }
  const intervalMs = Math.max(1, Number(store.settings.intervalMinutes || 15)) * 60 * 1000;
  store.scheduler.running = true;
  store.scheduler.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
  await saveStore(store);
  schedulerTimer = setInterval(async () => {
    try {
      await syncPrs({ triggerReview: true, reason: 'scheduled' });
      const latest = await ensureStore();
      latest.scheduler.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
      await saveStore(latest);
    } catch (error) {
      const latest = await ensureStore();
      latest.scheduler.lastRunAt = new Date().toISOString();
      latest.scheduler.lastError = error.message;
      addEvent(latest, 'sync-error', `定时同步失败：${error.message}`);
      await saveStore(latest);
    }
  }, intervalMs);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (!url.pathname.startsWith('/api/')) {
      const store = await ensureStore();
      const initAssets = ['/init.html', '/init.js', '/styles.css', '/app-icon.svg'];
      if (!store.initialized && !initAssets.includes(url.pathname)) {
        response.writeHead(302, { Location: '/init.html' });
        response.end();
        return;
      }
      if (store.initialized && url.pathname === '/init.html') {
        response.writeHead(302, { Location: '/' });
        response.end();
        return;
      }
      await sendStatic(response, url.pathname);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/state') {
      const store = await ensureStore();
      await sendJson(response, 200, await clientState(store));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/init/environment') {
      const store = await ensureStore();
      if (store.initialized && Object.keys(store.users || {}).length) {
        throw new Error('平台已经初始化。');
      }
      await sendJson(response, 200, await checkRuntimeEnvironment(store, {
        codexExecutablePath: url.searchParams.get('codexExecutablePath') || ''
      }));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/environment') {
      const store = await ensureStore();
      if (!canManagePlatform(currentUser(store))) {
        throw new Error('只有超级管理员或管理员可以检测平台环境。');
      }
      await sendJson(response, 200, await checkRuntimeEnvironment(store, {
        codexExecutablePath: url.searchParams.get('codexExecutablePath') || store.settings.codexExecutablePath || ''
      }));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/init/storage/test') {
      const body = await readJsonBody(request);
      const store = await ensureStore();
      if (store.initialized && Object.keys(store.users || {}).length) {
        throw new Error('平台已经初始化。');
      }
      const currentConfig = await loadStorageConfig();
      const nextConfig = normalizeStorageConfig({ ...currentConfig, ...body });
      await sendJson(response, 200, await testStorageConfig(nextConfig));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/init/token/test') {
      const body = await readJsonBody(request);
      const store = await ensureStore();
      if (store.initialized && Object.keys(store.users || {}).length) {
        throw new Error('平台已经初始化。');
      }
      const token = String(body.token || body.accessToken || '').trim();
      const baseUrl = String(body.baseUrl || store.settings.baseUrl || DEFAULT_BITBUCKET_BASE_URL).trim();
      await sendJson(response, 200, await testBitbucketToken({
        ...store,
        settings: {
          ...store.settings,
          baseUrl
        }
      }, token));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/init') {
      const body = await readJsonBody(request);
      const currentConfig = await loadStorageConfig();
      const nextConfig = body.storage
        ? normalizeStorageConfig({ ...currentConfig, ...body.storage })
        : currentConfig;
      const store = await ensureStore();
      if (store.initialized && Object.keys(store.users || {}).length) {
        throw new Error('平台已经初始化。');
      }
      const storageTest = await testStorageConfig(nextConfig);
      const user = normalizeUserInput({
        username: body.username,
        displayName: body.displayName,
        role: 'super-admin',
        bitbucketNames: body.bitbucketNames,
        repoPathMappings: body.repoPathMappings
      });
      const userId = userIdFromUsername(user.username);
      const token = String(body.token || body.accessToken || '').trim();
      const now = new Date().toISOString();
      store.users = {
        [userId]: {
          ...user,
          id: userId,
          role: 'super-admin',
          ...(token
            ? {
                bitbucketToken: token,
                bitbucketTokenUsername: user.username || 'unknown',
                bitbucketTokenDisplayName: user.displayName || user.username || 'unknown',
                bitbucketTokenUpdatedAt: now
              }
            : {})
        }
      };
      store.currentUserId = userId;
      store.initialized = true;
      store.settings = {
        ...store.settings,
        baseUrl: String(body.baseUrl || store.settings.baseUrl || DEFAULT_BITBUCKET_BASE_URL).trim(),
        intervalMinutes: Math.max(1, Number(body.intervalMinutes || store.settings.intervalMinutes || 15)),
        schedulerEnabled: Boolean(body.schedulerEnabled),
        autoReviewEnabled: Boolean(body.autoReviewEnabled),
        dangerousBypass: Boolean(body.dangerousBypass),
        codexExecutablePath: String(body.codexExecutablePath || '').trim()
      };
      if (token) {
        await syncLegacyTokenFile(store.users[userId]);
      }
      addEvent(store, 'init', `平台初始化完成，超级管理员：${user.displayName}`, { userId });
      await saveStore(store, nextConfig);
      const migratedStore = await readStoreFromConfig(nextConfig);
      if (!migratedStore) {
        throw new Error('初始化校验失败：目标存储写入后无法读取数据。');
      }
      assertStoreStatsMigrated(store, migratedStore);
      await saveStorageConfig(nextConfig);
      await refreshScheduler();
      await sendJson(response, 200, {
        state: await clientState(await ensureStore()),
        storageTest
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/settings') {
      const body = await readJsonBody(request);
      const store = await ensureStore();
      const user = currentUser(store);
      if (!canManagePlatform(user)) {
        throw new Error('只有超级管理员或管理员可以修改平台设置。');
      }
      if (
        body.defaultRepoPath !== undefined ||
        body.repoPathMappings !== undefined ||
        body.selfReviewerNames !== undefined ||
        body.bitbucketNames !== undefined
      ) {
        store.users[user.id] = {
          ...user,
          repoPathMappings: String(body.repoPathMappings ?? user.repoPathMappings ?? legacyRepoMapping(body.defaultRepoPath ?? user.defaultRepoPath)),
          bitbucketNames: String(body.bitbucketNames ?? body.selfReviewerNames ?? user.bitbucketNames ?? '')
        };
      }
      store.settings = {
        ...store.settings,
        schedulerEnabled: body.schedulerEnabled ?? store.settings.schedulerEnabled,
        autoReviewEnabled: body.autoReviewEnabled ?? store.settings.autoReviewEnabled,
        dangerousBypass: body.dangerousBypass ?? store.settings.dangerousBypass,
        codexExecutablePath: body.codexExecutablePath !== undefined
          ? String(body.codexExecutablePath || '').trim()
          : (store.settings.codexExecutablePath || ''),
        intervalMinutes: Math.max(1, Number(body.intervalMinutes ?? store.settings.intervalMinutes))
      };
      refreshStoredPrUrls(store);
      addEvent(store, 'settings', '设置已更新');
      await saveStore(store);
      await refreshScheduler();
      await sendJson(response, 200, await clientState(await ensureStore()));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/storage') {
      const body = await readJsonBody(request);
      const currentConfig = await loadStorageConfig();
      const nextConfig = normalizeStorageConfig({ ...currentConfig, ...body });
      const store = await ensureStore();
      if (!canManagePlatform(currentUser(store))) {
        throw new Error('只有超级管理员或管理员可以修改存储配置。');
      }
      const testResult = await testStorageConfig(nextConfig);
      await saveStore(store, nextConfig);
      const migratedStore = await readStoreFromConfig(nextConfig);
      if (!migratedStore) {
        throw new Error('迁移校验失败：目标存储写入后无法读取数据。');
      }
      const migration = assertStoreStatsMigrated(store, migratedStore);
      addEvent(store, 'storage', `存储已迁移并切换到：${storageForClient(nextConfig).label}`, {
        from: storageForClient(currentConfig).label,
        to: storageForClient(nextConfig).label,
        stats: migration.after
      });
      await saveStore(store, nextConfig);
      await saveStorageConfig(nextConfig);
      await refreshScheduler();
      await sendJson(response, 200, {
        state: await clientState(await ensureStore()),
        storageTest: testResult,
        migration
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/storage/test') {
      const body = await readJsonBody(request);
      const currentConfig = await loadStorageConfig();
      const nextConfig = normalizeStorageConfig({ ...currentConfig, ...body });
      const store = await ensureStore();
      if (!canManagePlatform(currentUser(store))) {
        throw new Error('只有超级管理员或管理员可以测试存储配置。');
      }
      await sendJson(response, 200, await testStorageConfig(nextConfig));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/users/switch') {
      const body = await readJsonBody(request);
      const store = await ensureStore();
      if (!store.users[body.userId]) throw new Error('User not found.');
      store.currentUserId = body.userId;
      addEvent(store, 'user-switch', `已切换用户：${store.users[body.userId].displayName}`, { userId: body.userId });
      await saveStore(store);
      await sendJson(response, 200, await clientState(store));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/users/current') {
      const body = await readJsonBody(request);
      const store = await ensureStore();
      const user = currentUser(store);
      store.users[user.id] = {
        ...user,
        username: String(body.username ?? user.username ?? ''),
        displayName: String(body.displayName ?? user.displayName ?? ''),
        bitbucketNames: String(body.bitbucketNames ?? user.bitbucketNames ?? ''),
        repoPathMappings: String(body.repoPathMappings ?? user.repoPathMappings ?? legacyRepoMapping(body.defaultRepoPath ?? user.defaultRepoPath))
      };
      addEvent(store, 'user-settings', `用户设置已更新：${store.users[user.id].displayName}`, { userId: user.id });
      await saveStore(store);
      await sendJson(response, 200, await clientState(store));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/users/current/token/test') {
      const body = await readJsonBody(request);
      const store = await ensureStore();
      const user = currentUser(store);
      const token = String(body.token || '').trim() || (await readTokenInfo(store, user)).token;
      await sendJson(response, 200, await testBitbucketToken(store, token));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/users/current/token') {
      const body = await readJsonBody(request);
      const store = await ensureStore();
      const user = currentUser(store);
      const token = String(body.token || body.accessToken || '').trim();
      if (!token) throw new Error('Bitbucket token 不能为空。');
      const now = new Date().toISOString();
      store.users[user.id] = {
        ...user,
        bitbucketToken: token,
        bitbucketTokenUsername: String(body.username || user.username || 'unknown').trim() || 'unknown',
        bitbucketTokenDisplayName: String(body.displayName || user.displayName || user.username || 'unknown').trim() || 'unknown',
        bitbucketTokenUpdatedAt: now
      };
      await syncLegacyTokenFile(store.users[user.id]);
      addEvent(store, 'token-save', `Bitbucket token 已更新：${store.users[user.id].displayName}`, { userId: user.id });
      await saveStore(store);
      await sendJson(response, 200, await clientState(store));
      return;
    }

    if (request.method === 'DELETE' && url.pathname === '/api/users/current/token') {
      const store = await ensureStore();
      const user = currentUser(store);
      const previousToken = tokenFromUser(user);
      delete user.bitbucketToken;
      delete user.bitbucketAccessToken;
      delete user.bitbucketTokenUsername;
      delete user.bitbucketTokenDisplayName;
      delete user.bitbucketTokenUpdatedAt;
      store.users[user.id] = user;
      await clearLegacyTokenFileIfMatching(previousToken);
      addEvent(store, 'token-clear', `Bitbucket token 已清除：${user.displayName}`, { userId: user.id });
      await saveStore(store);
      await sendJson(response, 200, await clientState(store));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/users') {
      const body = await readJsonBody(request);
      const store = await ensureStore();
      const actor = currentUser(store);
      if (!canManageUsers(actor)) {
        throw new Error('只有超级管理员可以管理用户。');
      }
      const user = normalizeUserInput(body);
      let userId = userIdFromUsername(user.username);
      let suffix = 2;
      while (store.users[userId]) {
        userId = `${userIdFromUsername(user.username)}-${suffix}`;
        suffix += 1;
      }
      store.users[userId] = { ...user, id: userId };
      addEvent(store, 'user-create', `已创建用户：${user.displayName}`, { userId, userIdCreated: userId, userIdActor: actor.id });
      await saveStore(store);
      await sendJson(response, 200, await clientState(store));
      return;
    }

    const userUpdateMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
    if (request.method === 'POST' && userUpdateMatch) {
      const body = await readJsonBody(request);
      const store = await ensureStore();
      const actor = currentUser(store);
      if (!canManageUsers(actor)) {
        throw new Error('只有超级管理员可以管理用户。');
      }
      const userId = decodeURIComponent(userUpdateMatch[1]);
      const existing = store.users[userId];
      if (!existing) throw new Error('用户不存在。');
      const nextUser = normalizeUserInput(body, existing);
      const superAdminCount = Object.values(store.users).filter((user) => user.role === 'super-admin').length;
      if (existing.role === 'super-admin' && nextUser.role !== 'super-admin' && superAdminCount <= 1) {
        throw new Error('至少需要保留一个超级管理员。');
      }
      store.users[userId] = {
        ...nextUser,
        id: userId
      };
      addEvent(store, 'user-update', `已更新用户：${nextUser.displayName}`, { userId, userIdActor: actor.id });
      await saveStore(store);
      await sendJson(response, 200, await clientState(store));
      return;
    }

    const userDeleteMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
    if (request.method === 'DELETE' && userDeleteMatch) {
      const store = await ensureStore();
      const actor = currentUser(store);
      if (!canManageUsers(actor)) {
        throw new Error('只有超级管理员可以管理用户。');
      }
      const userId = decodeURIComponent(userDeleteMatch[1]);
      const existing = store.users[userId];
      if (!existing) throw new Error('用户不存在。');
      if (existing.role === 'super-admin' && Object.values(store.users).filter((user) => user.role === 'super-admin').length <= 1) {
        throw new Error('至少需要保留一个超级管理员。');
      }
      delete store.users[userId];
      if (store.currentUserId === userId) {
        store.currentUserId = Object.keys(store.users)[0] || '';
      }
      for (const pr of Object.values(store.prs)) {
        if (pr.ownerUserId === userId) pr.statusBucket = 'archived';
      }
      addEvent(store, 'user-delete', `已删除用户：${existing.displayName}`, { userId, userIdActor: actor.id });
      await saveStore(store);
      await sendJson(response, 200, await clientState(store));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/sync') {
      const store = await syncPrs({ triggerReview: false, reason: 'manual' });
      await sendJson(response, 200, await clientState(store));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/scheduler/run-now') {
      const store = await syncPrs({ triggerReview: true, reason: 'run-now' });
      await sendJson(response, 200, await clientState(store));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/import') {
      const body = await readJsonBody(request);
      const imported = [];
      const entries = String(body.input || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
      for (const entry of entries) {
        imported.push(await importPr(entry, body.localRepoPath || ''));
      }
      const store = await ensureStore();
      await sendJson(response, 200, { imported, state: await clientState(store) });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/jobs') {
      const body = await readJsonBody(request);
      const store = await ensureStore();
      const pr = store.prs[body.prKey];
      if (!pr) throw new Error('PR not found.');
      const actor = currentUser(store);
      if (!isAdmin(actor) && pr.ownerUserId !== actor.id) {
        throw new Error('不能为其他用户的 PR 创建 review 任务。');
      }
      const job = createReviewJob(store, pr, 'manual');
      await saveStore(store);
      await sendJson(response, 200, { job, state: await clientState(store) });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/prs/approve') {
      const body = await readJsonBody(request);
      const { pr, store } = await approvePr(body.prKey);
      await sendJson(response, 200, { pr, state: await clientState(store) });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/prs/local-repo-path') {
      const body = await readJsonBody(request);
      const { pr, store } = await updatePrLocalRepoPath(body.prKey, body.localRepoPath, Boolean(body.saveAsMapping));
      await sendJson(response, 200, { pr, state: await clientState(store) });
      return;
    }

    const runMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/run$/);
    if (request.method === 'POST' && runMatch) {
      const job = await runReviewJob(runMatch[1]);
      const store = await ensureStore();
      await sendJson(response, 200, { job, state: await clientState(store) });
      return;
    }

    const deleteMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (request.method === 'DELETE' && deleteMatch) {
      const { job, store } = await deleteReviewJob(deleteMatch[1]);
      await sendJson(response, 200, { job, state: await clientState(store) });
      return;
    }

    const postDeleteMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/delete$/);
    if (request.method === 'POST' && postDeleteMatch) {
      const { job, store } = await deleteReviewJob(postDeleteMatch[1]);
      await sendJson(response, 200, { job, state: await clientState(store) });
      return;
    }

    await sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    await sendJson(response, 500, { error: error.message });
  }
});

export async function startServer({ port = PORT, host = '127.0.0.1' } = {}) {
  const store = await ensureStore();
  if (!startupReconcileDone) {
    startupReconcileDone = true;
    if (await reconcileStaleRunningJobs(store, { graceMs: 60_000 })) {
      await saveStore(store);
    }
  }
  await refreshScheduler();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      console.log(`PR monitor platform running at http://${host}:${actualPort}`);
      resolve({ server, port: actualPort, host });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startServer({ port: PORT, host: process.env.HOST || '127.0.0.1' });
}
