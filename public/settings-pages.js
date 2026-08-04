let state = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

function formatTime(value) {
  if (!value) return '未执行';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setStatus(selector, text, kind = 'ok') {
  const target = $(selector);
  if (!target) return;
  target.textContent = text;
  target.className = `save-status ${kind}`;
}

function roleLabel(role) {
  return {
    'super-admin': '超级管理员',
    admin: '管理员',
    user: '普通用户'
  }[role] || role || '普通用户';
}

function selectedStorageDriver() {
  return document.querySelector('input[name="storageDriverChoice"]:checked')?.value || 'local-file';
}

function selectedDatabaseInputMode() {
  return document.querySelector('input[name="databaseInputMode"]:checked')?.value || 'full';
}

function defaultPortForEngine(engine) {
  return {
    postgresql: '5432',
    mysql: '3306',
    mariadb: '3306'
  }[engine] || '';
}

function encodeCredential(value) {
  return encodeURIComponent(value);
}

function databaseConfigFromForm() {
  return {
    mode: selectedDatabaseInputMode(),
    engine: $('#storageDbEngine')?.value || 'sqlite',
    host: $('#storageDbHost')?.value.trim() || '',
    port: $('#storageDbPort')?.value.trim() || '',
    database: $('#storageDbName')?.value.trim() || '',
    username: $('#storageDbUser')?.value.trim() || '',
    password: $('#storageDbPassword')?.value || '',
    params: $('#storageDbParams')?.value.trim() || ''
  };
}

function databaseUrlFromConfig(config) {
  const engine = config.engine || 'sqlite';
  const params = config.params ? `?${config.params.replace(/^\?/, '')}` : '';
  if (engine === 'sqlite' || engine === 'file') {
    const database = config.database || '';
    if (!database) return '';
    if (database.includes('://')) return `${database}${params}`;
    const normalizedPath = database.replaceAll('\\', '/');
    const pathPrefix = /^[A-Za-z]:\//.test(normalizedPath) || normalizedPath.startsWith('/') ? '///' : '';
    return `file:${pathPrefix}${encodeURI(normalizedPath)}${params}`;
  }

  const auth = config.username
    ? `${encodeCredential(config.username)}${config.password ? `:${encodeURIComponent(config.password)}` : ''}@`
    : '';
  const host = config.host || '127.0.0.1';
  const port = config.port ? `:${config.port}` : '';
  const database = config.database ? `/${encodeURIComponent(config.database).replaceAll('%2F', '/')}` : '';
  return `${engine}://${auth}${host}${port}${database}${params}`;
}

function parseDatabaseUrl(databaseUrl) {
  if (!databaseUrl) return {};
  try {
    const url = new URL(databaseUrl);
    const engine = url.protocol.replace(':', '') || 'sqlite';
    const isFileLike = ['sqlite', 'file'].includes(engine);
    return {
      mode: 'full',
      engine,
      host: isFileLike ? '' : url.hostname,
      port: isFileLike ? '' : url.port,
      database: isFileLike
        ? decodeURIComponent((url.pathname || '').replace(/^\/([A-Za-z]:\/)/, '$1'))
        : decodeURIComponent(url.pathname.replace(/^\//, '')),
      username: decodeURIComponent(url.username || ''),
      password: decodeURIComponent(url.password || ''),
      params: url.search.replace(/^\?/, '')
    };
  } catch {
    return {
      mode: 'full',
      engine: 'sqlite',
      database: databaseUrl
    };
  }
}

function renderStoragePanes() {
  const selected = selectedStorageDriver();
  $$('[data-storage-pane]').forEach((pane) => {
    pane.hidden = pane.dataset.storagePane === 'database'
      ? !['sqlite', 'mysql'].includes(selected)
      : pane.dataset.storagePane !== selected;
  });
  if (selected === 'mysql' && ['sqlite', 'file'].includes($('#storageDbEngine')?.value)) {
    $('#storageDbEngine').value = 'mysql';
  }
  if (selected === 'sqlite' && !['sqlite', 'file'].includes($('#storageDbEngine')?.value)) {
    $('#storageDbEngine').value = 'sqlite';
  }
  renderDatabaseMode();
}

function renderDatabaseMode() {
  const selected = selectedDatabaseInputMode();
  $$('[data-database-mode]').forEach((pane) => {
    pane.hidden = pane.dataset.databaseMode !== selected;
  });
  updateDatabasePreview();
}

function updateDatabasePreview() {
  const config = databaseConfigFromForm();
  const engine = config.engine;
  if (!config.port) {
    const defaultPort = defaultPortForEngine(engine);
    if (defaultPort && document.activeElement !== $('#storageDbPort')) {
      $('#storageDbPort').placeholder = defaultPort;
    }
  }
  const preview = databaseUrlFromConfig(config);
  if ($('#storageDatabasePreview')) {
    $('#storageDatabasePreview').value = preview;
  }
}

function storagePayloadFromForm() {
  const databaseConfig = databaseConfigFromForm();
  const databaseUrl = databaseConfig.mode === 'parts'
    ? databaseUrlFromConfig(databaseConfig)
    : $('#storageDatabaseUrl').value.trim();
  return {
    driver: selectedStorageDriver(),
    filePath: $('#storageFilePath').value.trim(),
    compressed: $('#storageCompressed').checked,
    databaseUrl,
    databaseConfig
  };
}

function storageStatsText(stats) {
  if (!stats) return '目标存储暂无现有平台数据。';
  return `目标已有数据：用户 ${stats.users}，PR ${stats.prs}，任务 ${stats.jobs}，日志 ${stats.logs || 0}。`;
}

function renderMigrationPreview(result = null) {
  const target = $('#storageMigrationPreview');
  if (!target) return;
  if (!result) {
    target.innerHTML = `
      <strong>迁移流程</strong>
      <span>测试连接会验证目标可用并自动建表；保存并迁移会把当前用户、PR、任务和日志写入目标存储，读回校验成功后才切换。</span>
    `;
    return;
  }
  if (result.migration) {
    const before = result.migration.before;
    const after = result.migration.after;
    target.innerHTML = `
      <strong>迁移已校验</strong>
      <span>源数据：用户 ${before.users}，PR ${before.prs}，任务 ${before.jobs}，日志 ${before.logs || 0}。</span>
      <span>目标数据：用户 ${after.users}，PR ${after.prs}，任务 ${after.jobs}，日志 ${after.logs || 0}。</span>
    `;
    return;
  }
  target.innerHTML = `
    <strong>连接测试通过</strong>
    <span>${escapeHtml(result.message || '目标存储可用。')}</span>
    <span>${escapeHtml(storageStatsText(result.stats))}</span>
  `;
}

function tokenStatusHtml() {
  const token = state.token;
  if (!token) {
    return `
      <strong>未配置 Bitbucket token</strong>
      <span>同步 PR、自动 review 和 approve 前，请先保存当前用户的 access token。</span>
    `;
  }
  const sourceText = token.source === 'user' ? '当前用户配置' : 'skill 本地认证文件';
  return `
    <strong>已配置 Bitbucket token</strong>
    <span>来源：${sourceText}</span>
    <span>身份：${escapeHtml(token.displayName || token.username || 'unknown')}</span>
    <span>更新时间：${formatTime(token.updatedAt)}</span>
  `;
}

function renderUserPage() {
  if (!$('#userSettingsForm')) return;
  const user = state.currentUser;
  $('#userSettingsSubtitle').textContent = `${user.displayName || user.username} · ${roleLabel(user.role)}`;
  $('#platformSettingsLink').hidden = !state.permissions?.canManagePlatform;
  $('#userManagementLink').hidden = !state.permissions?.canManageUsers;
  $('#userDisplayName').value = user.displayName || '';
  $('#userUsername').value = user.username || '';
  $('#userBitbucketNames').value = user.bitbucketNames || '';
  $('#userRepoPathMappings').value = user.repoPathMappings || '';
  if ($('#tokenStatusCard')) {
    $('#tokenStatusCard').innerHTML = tokenStatusHtml();
  }
  if ($('#clearTokenBtn')) {
    $('#clearTokenBtn').disabled = !user.hasBitbucketToken;
  }
}

function renderPlatformPage() {
  if (!$('#taskSettingsForm')) return;
  if (!state.permissions?.canManagePlatform) {
    window.location.href = '/user-settings.html';
    return;
  }
  $('#intervalMinutes').value = state.settings.intervalMinutes;
  $('#schedulerEnabled').checked = Boolean(state.settings.schedulerEnabled);
  $('#autoReviewEnabled').checked = Boolean(state.settings.autoReviewEnabled);
  $('#dangerousBypass').checked = Boolean(state.settings.dangerousBypass);
  $('#schedulerPreview').innerHTML = `
    <div>定时任务：${state.scheduler.running ? '运行中' : '已停止'}</div>
    <div>上次执行：${formatTime(state.scheduler.lastRunAt)}</div>
    <div>下次执行：${formatTime(state.scheduler.nextRunAt)}</div>
    ${state.scheduler.lastError ? `<div class="error">错误：${escapeHtml(state.scheduler.lastError)}</div>` : ''}
  `;

  const storage = state.storage || {};
  const canManage = Boolean(state.permissions?.canManageStorage);
  $('#storageSummary').innerHTML = `
    <div>
      <span>当前后端</span>
      <strong>${storage.driver === 'mysql' ? 'MySQL 数据库' : storage.driver === 'sqlite' ? 'SQLite 数据库' : '本地文件'}</strong>
    </div>
    <div>
      <span>当前位置</span>
      <strong>${escapeHtml(storage.label || '未配置')}</strong>
    </div>
    <div>
      <span>压缩写入</span>
      <strong>${storage.compressed || String(storage.filePath || '').endsWith('.gz') ? '启用或自动识别 gzip' : '未启用'}</strong>
    </div>
  `;
  $('#storagePermissionNotice').hidden = canManage;
  $$('input[name="storageDriverChoice"]').forEach((input) => {
    input.checked = input.value === (storage.driver || 'local-file');
    input.disabled = !canManage;
  });
  $('#storageFilePath').value = storage.filePath || '';
  $('#storageCompressed').checked = Boolean(storage.compressed);
  $('#storageDatabaseUrl').value = storage.databaseUrl || '';
  const parsedDatabaseConfig = {
    ...parseDatabaseUrl(storage.databaseUrl || ''),
    ...(storage.databaseConfig || {})
  };
  $$('input[name="databaseInputMode"]').forEach((input) => {
    input.checked = input.value === (parsedDatabaseConfig.mode || 'full');
  });
  $('#storageDbEngine').value = parsedDatabaseConfig.engine || 'sqlite';
  $('#storageDbHost').value = parsedDatabaseConfig.host || '';
  $('#storageDbPort').value = parsedDatabaseConfig.port || '';
  $('#storageDbName').value = parsedDatabaseConfig.database || '';
  $('#storageDbUser').value = parsedDatabaseConfig.username || '';
  $('#storageDbPassword').value = parsedDatabaseConfig.password || '';
  $('#storageDbParams').value = parsedDatabaseConfig.params || '';
  $('#storageSettingsForm').querySelectorAll('input, select, textarea, button').forEach((control) => {
    control.disabled = !canManage;
  });
  renderStoragePanes();
  renderMigrationPreview();
}

async function load() {
  state = await api('/api/state');
  if (state.initialized === false) {
    window.location.href = '/init.html';
    return;
  }
  renderUserPage();
  renderPlatformPage();
}

$('#userSettingsForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  setStatus('#userSaveStatus', '保存中...', 'busy');
  try {
    const result = await api('/api/users/current', {
      method: 'POST',
      body: JSON.stringify({
        displayName: $('#userDisplayName').value.trim(),
        username: $('#userUsername').value.trim(),
        bitbucketNames: $('#userBitbucketNames').value.trim(),
        repoPathMappings: $('#userRepoPathMappings').value.trim()
      })
    });
    state = result.state || result;
    renderUserPage();
    setStatus('#userSaveStatus', '已保存');
  } catch (error) {
    setStatus('#userSaveStatus', error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

$('#tokenSettingsForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  setStatus('#tokenSaveStatus', '保存中...', 'busy');
  try {
    const result = await api('/api/users/current/token', {
      method: 'POST',
      body: JSON.stringify({
        token: $('#userBitbucketToken').value.trim()
      })
    });
    state = result.state || result;
    $('#userBitbucketToken').value = '';
    renderUserPage();
    setStatus('#tokenSaveStatus', '已保存并同步到 review skill');
  } catch (error) {
    setStatus('#tokenSaveStatus', error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

$('#testTokenBtn')?.addEventListener('click', async () => {
  const button = $('#testTokenBtn');
  button.disabled = true;
  setStatus('#tokenSaveStatus', '测试连接中...', 'busy');
  try {
    const result = await api('/api/users/current/token/test', {
      method: 'POST',
      body: JSON.stringify({
        token: $('#userBitbucketToken').value.trim()
      })
    });
    setStatus('#tokenSaveStatus', result.message || '连接测试通过');
  } catch (error) {
    setStatus('#tokenSaveStatus', error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

$('#clearTokenBtn')?.addEventListener('click', async () => {
  const button = $('#clearTokenBtn');
  button.disabled = true;
  setStatus('#tokenSaveStatus', '清除中...', 'busy');
  try {
    const result = await api('/api/users/current/token', { method: 'DELETE' });
    state = result.state || result;
    $('#userBitbucketToken').value = '';
    renderUserPage();
    setStatus('#tokenSaveStatus', '已清除当前用户 token');
  } catch (error) {
    setStatus('#tokenSaveStatus', error.message, 'error');
  } finally {
    renderUserPage();
  }
});

$('#taskSettingsForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  setStatus('#taskSaveStatus', '保存中...', 'busy');
  try {
    const result = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        intervalMinutes: $('#intervalMinutes').value,
        schedulerEnabled: $('#schedulerEnabled').checked,
        autoReviewEnabled: $('#autoReviewEnabled').checked,
        dangerousBypass: $('#dangerousBypass').checked
      })
    });
    state = result.state || result;
    renderPlatformPage();
    setStatus('#taskSaveStatus', '已保存');
  } catch (error) {
    setStatus('#taskSaveStatus', error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

$('#storageSettingsForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#saveStorageBtn');
  button.disabled = true;
  $('#testStorageBtn').disabled = true;
  setStatus('#storageSaveStatus', '正在测试、迁移并校验...', 'busy');
  try {
    const result = await api('/api/storage', {
      method: 'POST',
      body: JSON.stringify(storagePayloadFromForm())
    });
    state = result.state || result;
    renderPlatformPage();
    renderMigrationPreview(result);
    setStatus('#storageSaveStatus', '已迁移并切换');
  } catch (error) {
    setStatus('#storageSaveStatus', error.message, 'error');
  } finally {
    const canManage = Boolean(state?.permissions?.canManageStorage);
    button.disabled = !canManage;
    $('#testStorageBtn').disabled = !canManage;
  }
});

$('#testStorageBtn')?.addEventListener('click', async () => {
  const button = $('#testStorageBtn');
  button.disabled = true;
  $('#saveStorageBtn').disabled = true;
  setStatus('#storageSaveStatus', '测试连接中...', 'busy');
  try {
    const result = await api('/api/storage/test', {
      method: 'POST',
      body: JSON.stringify(storagePayloadFromForm())
    });
    renderMigrationPreview(result);
    setStatus('#storageSaveStatus', result.message || '连接测试通过');
  } catch (error) {
    setStatus('#storageSaveStatus', error.message, 'error');
  } finally {
    const canManage = Boolean(state?.permissions?.canManageStorage);
    button.disabled = !canManage;
    $('#saveStorageBtn').disabled = !canManage;
  }
});

$$('input[name="storageDriverChoice"]').forEach((input) => {
  input.addEventListener('change', () => {
    renderStoragePanes();
    renderMigrationPreview();
    setStatus('#storageSaveStatus', '');
  });
});

$$('input[name="databaseInputMode"]').forEach((input) => {
  input.addEventListener('change', () => {
    renderDatabaseMode();
    renderMigrationPreview();
    setStatus('#storageSaveStatus', '');
  });
});

['#storageDbEngine', '#storageDbHost', '#storageDbPort', '#storageDbName', '#storageDbUser', '#storageDbPassword', '#storageDbParams'].forEach((selector) => {
  $(selector)?.addEventListener('input', () => {
    updateDatabasePreview();
    renderMigrationPreview();
    setStatus('#storageSaveStatus', '');
  });
  $(selector)?.addEventListener('change', () => {
    updateDatabasePreview();
    renderMigrationPreview();
    setStatus('#storageSaveStatus', '');
  });
});

['#storageFilePath', '#storageCompressed', '#storageDatabaseUrl'].forEach((selector) => {
  $(selector)?.addEventListener('input', () => {
    renderMigrationPreview();
    setStatus('#storageSaveStatus', '');
  });
  $(selector)?.addEventListener('change', () => {
    renderMigrationPreview();
    setStatus('#storageSaveStatus', '');
  });
});

load().catch((error) => {
  document.body.innerHTML = `<main class="shell"><section class="panel settings-card"><h1>启动失败</h1><p class="error">${escapeHtml(error.message)}</p></section></main>`;
});
