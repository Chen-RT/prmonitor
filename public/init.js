const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

let state = null;
let currentStep = 0;
let tokenTested = false;
let storageTested = false;
let environmentChecked = false;

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

function selectedStorageDriver() {
  return document.querySelector('input[name="initStorageDriverChoice"]:checked')?.value || 'local-file';
}

function selectedDatabaseInputMode() {
  return document.querySelector('input[name="initDatabaseInputMode"]:checked')?.value || 'full';
}

function defaultPortForEngine(engine) {
  return {
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
    engine: $('#initStorageDbEngine')?.value || 'sqlite',
    host: $('#initStorageDbHost')?.value.trim() || '',
    port: $('#initStorageDbPort')?.value.trim() || '',
    database: $('#initStorageDbName')?.value.trim() || '',
    username: $('#initStorageDbUser')?.value.trim() || '',
    password: $('#initStorageDbPassword')?.value || '',
    params: $('#initStorageDbParams')?.value.trim() || ''
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

function storagePayloadFromForm() {
  const databaseConfig = databaseConfigFromForm();
  const databaseUrl = databaseConfig.mode === 'parts'
    ? databaseUrlFromConfig(databaseConfig)
    : $('#initStorageDatabaseUrl').value.trim();
  return {
    driver: selectedStorageDriver(),
    filePath: $('#initStorageFilePath').value.trim(),
    compressed: $('#initStorageCompressed').checked,
    databaseUrl,
    databaseConfig
  };
}

function renderStoragePanes() {
  const selected = selectedStorageDriver();
  $$('[data-init-storage-pane]').forEach((pane) => {
    pane.hidden = pane.dataset.initStoragePane === 'database'
      ? !['sqlite', 'mysql'].includes(selected)
      : pane.dataset.initStoragePane !== selected;
  });
  if (selected === 'mysql' && ['sqlite', 'file'].includes($('#initStorageDbEngine')?.value)) {
    $('#initStorageDbEngine').value = 'mysql';
  }
  if (selected === 'sqlite' && !['sqlite', 'file'].includes($('#initStorageDbEngine')?.value)) {
    $('#initStorageDbEngine').value = 'sqlite';
  }
  renderDatabaseMode();
}

function renderDatabaseMode() {
  const selected = selectedDatabaseInputMode();
  $$('[data-init-database-mode]').forEach((pane) => {
    pane.hidden = pane.dataset.initDatabaseMode !== selected;
  });
  updateDatabasePreview();
}

function updateDatabasePreview() {
  const config = databaseConfigFromForm();
  const defaultPort = defaultPortForEngine(config.engine);
  if ($('#initStorageDbPort') && defaultPort) {
    $('#initStorageDbPort').placeholder = defaultPort;
  }
  if ($('#initStorageDatabasePreview')) {
    $('#initStorageDatabasePreview').value = databaseUrlFromConfig(config);
  }
}

function storageStatsText(stats) {
  if (!stats) return '目标存储暂无现有平台数据。';
  return `目标已有数据：用户 ${stats.users}，PR ${stats.prs}，任务 ${stats.jobs}，日志 ${stats.logs || 0}。`;
}

function renderStoragePreview(result = null) {
  const target = $('#initStoragePreview');
  if (!target) return;
  if (!result) {
    target.innerHTML = `
      <strong>等待测试连接</strong>
      <span>完成初始化前会再次测试、自动建表并读回校验。</span>
    `;
    return;
  }
  target.innerHTML = `
    <strong>连接测试通过</strong>
    <span>${escapeHtml(result.message || '目标存储可用。')}</span>
    <span>${escapeHtml(storageStatsText(result.stats))}</span>
  `;
}

function renderTokenPreview(message = '') {
  const target = $('#initTokenPreview');
  if (!target) return;
  if (tokenTested) {
    target.innerHTML = `
      <strong>Bitbucket 连接已通过</strong>
      <span>${escapeHtml(message || 'Token 可以读取当前账号的 PR 看板。')}</span>
    `;
    return;
  }
  if (state?.token) {
    target.innerHTML = `
      <strong>检测到 skill 本地 token</strong>
      <span>初始化仍建议保存当前用户 token；如果不填写，会继续兜底使用现有 skill token。</span>
    `;
    return;
  }
  target.innerHTML = `
    <strong>等待测试连接</strong>
    <span>输入 token 后点击测试，确认可以读取 PR 看板。</span>
  `;
}

function renderEnvironment(result = null) {
  const target = $('#initEnvironmentList');
  if (!target) return;
  if (!result) {
    target.innerHTML = `
      <div class="environment-item pending">
        <strong>等待检测</strong>
        <span>点击检测后会确认 Codex CLI、review skill 和仓库搜索目录。</span>
      </div>
    `;
    return;
  }
  target.innerHTML = result.checks.map((check) => `
    <div class="environment-item ${check.ok ? 'ok' : 'bad'}">
      <strong>${escapeHtml(check.label)}</strong>
      <span>${escapeHtml(check.message)}</span>
    </div>
  `).join('');
}

function renderSummary() {
  const storage = storagePayloadFromForm();
  const storageLabel = storage.driver === 'mysql'
    ? 'MySQL'
    : storage.driver === 'sqlite'
      ? 'SQLite'
      : '本地文件';
  $('#initSummary').innerHTML = `
    <div><span>超级管理员</span><strong>${escapeHtml($('#initDisplayName').value.trim() || $('#initUsername').value.trim() || '未填写')}</strong></div>
    <div><span>Bitbucket</span><strong>${escapeHtml($('#initBaseUrl').value.trim() || '未填写')}</strong></div>
    <div><span>Token</span><strong>${tokenTested ? '已测试' : state?.token ? '将兜底使用 skill token' : '未测试'}</strong></div>
    <div><span>存储</span><strong>${storageLabel}${storageTested ? '，已测试' : '，未测试'}</strong></div>
    <div><span>本机环境</span><strong>${environmentChecked ? '已检测' : $('#initCodexExecutablePath')?.value.trim() ? '已填写 Codex 路径' : '未检测'}</strong></div>
    <div><span>自动 review</span><strong>${$('#initAutoReviewEnabled').checked ? '启用' : '关闭'}</strong></div>
  `;
}

function renderStep() {
  $$('[data-step]').forEach((pane) => {
    pane.classList.toggle('active', Number(pane.dataset.step) === currentStep);
  });
  $$('[data-step-target]').forEach((button) => {
    button.classList.toggle('active', Number(button.dataset.stepTarget) === currentStep);
  });
  $('#prevStepBtn').disabled = currentStep === 0;
  $('#nextStepBtn').hidden = currentStep === 4;
  $('#finishInitBtn').hidden = currentStep !== 4;
  renderSummary();
}

function validateStep(step) {
  if (step === 0) {
    if (!$('#initDisplayName').value.trim()) throw new Error('请填写超级管理员显示名。');
    if (!$('#initUsername').value.trim()) throw new Error('请填写超级管理员用户名。');
  }
  if (step === 1 && !tokenTested && !state?.token) {
    throw new Error('请先测试 Bitbucket token，或确认已有可用的 skill 本地 token。');
  }
  if (step === 2 && !storageTested) {
    throw new Error('请先测试存储连接。');
  }
}

function fillStorageDefaults(storage = {}) {
  $$('input[name="initStorageDriverChoice"]').forEach((input) => {
    input.checked = input.value === (storage.driver || 'local-file');
  });
  $('#initStorageFilePath').value = storage.filePath || '';
  $('#initStorageCompressed').checked = Boolean(storage.compressed);
  $('#initStorageDatabaseUrl').value = storage.databaseUrl || '';
  const parsedDatabaseConfig = {
    ...parseDatabaseUrl(storage.databaseUrl || ''),
    ...(storage.databaseConfig || {})
  };
  $$('input[name="initDatabaseInputMode"]').forEach((input) => {
    input.checked = input.value === (parsedDatabaseConfig.mode || 'full');
  });
  $('#initStorageDbEngine').value = parsedDatabaseConfig.engine || 'sqlite';
  $('#initStorageDbHost').value = parsedDatabaseConfig.host || '';
  $('#initStorageDbPort').value = parsedDatabaseConfig.port || '';
  $('#initStorageDbName').value = parsedDatabaseConfig.database || '';
  $('#initStorageDbUser').value = parsedDatabaseConfig.username || '';
  $('#initStorageDbPassword').value = parsedDatabaseConfig.password || '';
  $('#initStorageDbParams').value = parsedDatabaseConfig.params || '';
  renderStoragePanes();
  renderStoragePreview();
}

async function checkEnvironment() {
  const button = $('#checkEnvironmentBtn');
  button.disabled = true;
  setStatus('#initEnvironmentStatus', '检测中...', 'busy');
  try {
    const codexPath = $('#initCodexExecutablePath')?.value.trim() || '';
    const repoPathMappings = $('#initRepoPathMappings')?.value.trim() || '';
    const query = new URLSearchParams();
    if (codexPath) query.set('codexExecutablePath', codexPath);
    if (repoPathMappings) query.set('repoPathMappings', repoPathMappings);
    const result = await api(`/api/init/environment${query.size ? `?${query}` : ''}`);
    environmentChecked = true;
    renderEnvironment(result);
    setStatus('#initEnvironmentStatus', result.ok ? '环境检测通过' : '存在需要处理的环境项', result.ok ? 'ok' : 'error');
  } catch (error) {
    setStatus('#initEnvironmentStatus', error.message, 'error');
  } finally {
    button.disabled = false;
    renderSummary();
  }
}

async function load() {
  state = await api('/api/state');
  if (state.initialized !== false) {
    window.location.href = '/';
    return;
  }
  fillStorageDefaults(state.storage || {});
  renderTokenPreview();
  renderEnvironment();
  renderStep();
}

$('#prevStepBtn')?.addEventListener('click', () => {
  currentStep = Math.max(0, currentStep - 1);
  setStatus('#initStatus', '');
  renderStep();
});

$('#nextStepBtn')?.addEventListener('click', () => {
  try {
    validateStep(currentStep);
    currentStep = Math.min(4, currentStep + 1);
    setStatus('#initStatus', '');
    renderStep();
    if (currentStep === 3 && !environmentChecked) {
      checkEnvironment().catch(() => {});
    }
  } catch (error) {
    setStatus('#initStatus', error.message, 'error');
  }
});

$$('[data-step-target]').forEach((button) => {
  button.addEventListener('click', () => {
    const target = Number(button.dataset.stepTarget);
    try {
      for (let step = 0; step < target; step += 1) validateStep(step);
      currentStep = target;
      setStatus('#initStatus', '');
      renderStep();
      if (currentStep === 3 && !environmentChecked) {
        checkEnvironment().catch(() => {});
      }
    } catch (error) {
      setStatus('#initStatus', error.message, 'error');
    }
  });
});

$('#testInitTokenBtn')?.addEventListener('click', async () => {
  const button = $('#testInitTokenBtn');
  button.disabled = true;
  tokenTested = false;
  setStatus('#initTokenStatus', '测试 Bitbucket 中...', 'busy');
  try {
    const result = await api('/api/init/token/test', {
      method: 'POST',
      body: JSON.stringify({
        baseUrl: $('#initBaseUrl').value.trim(),
        token: $('#initBitbucketToken').value.trim()
      })
    });
    tokenTested = true;
    renderTokenPreview(result.message);
    setStatus('#initTokenStatus', result.message || 'Bitbucket 连接通过');
  } catch (error) {
    renderTokenPreview();
    setStatus('#initTokenStatus', error.message, 'error');
  } finally {
    button.disabled = false;
    renderSummary();
  }
});

$('#testInitStorageBtn')?.addEventListener('click', async () => {
  const button = $('#testInitStorageBtn');
  button.disabled = true;
  storageTested = false;
  setStatus('#initStorageStatus', '测试存储连接中...', 'busy');
  try {
    const result = await api('/api/init/storage/test', {
      method: 'POST',
      body: JSON.stringify(storagePayloadFromForm())
    });
    storageTested = true;
    renderStoragePreview(result);
    setStatus('#initStorageStatus', result.message || '存储连接通过');
  } catch (error) {
    renderStoragePreview();
    setStatus('#initStorageStatus', error.message, 'error');
  } finally {
    button.disabled = false;
    renderSummary();
  }
});

$('#checkEnvironmentBtn')?.addEventListener('click', () => {
  checkEnvironment().catch(() => {});
});

$$('input[name="initStorageDriverChoice"]').forEach((input) => {
  input.addEventListener('change', () => {
    storageTested = false;
    renderStoragePanes();
    renderStoragePreview();
    setStatus('#initStorageStatus', '');
    renderSummary();
  });
});

$$('input[name="initDatabaseInputMode"]').forEach((input) => {
  input.addEventListener('change', () => {
    storageTested = false;
    renderDatabaseMode();
    renderStoragePreview();
    setStatus('#initStorageStatus', '');
    renderSummary();
  });
});

[
  '#initStorageDbEngine',
  '#initStorageDbHost',
  '#initStorageDbPort',
  '#initStorageDbName',
  '#initStorageDbUser',
  '#initStorageDbPassword',
  '#initStorageDbParams',
  '#initStorageFilePath',
  '#initStorageCompressed',
  '#initStorageDatabaseUrl'
].forEach((selector) => {
  $(selector)?.addEventListener('input', () => {
    storageTested = false;
    updateDatabasePreview();
    renderStoragePreview();
    setStatus('#initStorageStatus', '');
    renderSummary();
  });
  $(selector)?.addEventListener('change', () => {
    storageTested = false;
    updateDatabasePreview();
    renderStoragePreview();
    setStatus('#initStorageStatus', '');
    renderSummary();
  });
});

['#initDisplayName', '#initUsername', '#initBaseUrl', '#initAutoReviewEnabled'].forEach((selector) => {
  $(selector)?.addEventListener('input', renderSummary);
  $(selector)?.addEventListener('change', renderSummary);
});

$('#initCodexExecutablePath')?.addEventListener('input', () => {
  environmentChecked = false;
  renderEnvironment();
  renderSummary();
  setStatus('#initEnvironmentStatus', '');
});

$('#initBitbucketToken')?.addEventListener('input', () => {
  tokenTested = false;
  renderTokenPreview();
  setStatus('#initTokenStatus', '');
  renderSummary();
});

$('#initForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#finishInitBtn');
  button.disabled = true;
  setStatus('#initStatus', '初始化中...', 'busy');
  try {
    for (let step = 0; step <= 2; step += 1) validateStep(step);
    await api('/api/init', {
      method: 'POST',
      body: JSON.stringify({
        displayName: $('#initDisplayName').value.trim(),
        username: $('#initUsername').value.trim(),
        bitbucketNames: $('#initBitbucketNames').value.trim(),
        repoPathMappings: $('#initRepoPathMappings').value.trim(),
        token: $('#initBitbucketToken').value.trim(),
        baseUrl: $('#initBaseUrl').value.trim(),
        intervalMinutes: $('#initIntervalMinutes').value,
        schedulerEnabled: $('#initSchedulerEnabled').checked,
        autoReviewEnabled: $('#initAutoReviewEnabled').checked,
        dangerousBypass: $('#initDangerousBypass').checked,
        codexExecutablePath: $('#initCodexExecutablePath')?.value.trim() || '',
        storage: storagePayloadFromForm()
      })
    });
    setStatus('#initStatus', '初始化完成，正在进入监控台...');
    window.location.href = '/';
  } catch (error) {
    setStatus('#initStatus', error.message, 'error');
    button.disabled = false;
  }
});

load().catch((error) => {
  document.body.innerHTML = `<main class="shell"><section class="panel settings-card"><h1>启动失败</h1><p class="error">${escapeHtml(error.message)}</p></section></main>`;
});
