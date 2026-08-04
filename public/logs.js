let state = null;

const $ = (selector) => document.querySelector(selector);

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

function formatTime(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value));
}

function renderFilters() {
  const types = [...new Set((state.logs || []).map((log) => log.type).filter(Boolean))].sort();
  const selectedType = $('#logTypeFilter').value || 'all';
  $('#logTypeFilter').innerHTML = `
    <option value="all">全部类型</option>
    ${types.map((type) => `<option value="${escapeHtml(type)}" ${type === selectedType ? 'selected' : ''}>${escapeHtml(type)}</option>`).join('')}
  `;
}

function renderLogsTable() {
  const selectedType = $('#logTypeFilter').value || 'all';
  const logs = (state.logs || []).filter((log) => selectedType === 'all' || log.type === selectedType);
  $('#logsTable').innerHTML = logs.length ? `
    <table class="table log-table">
      <thead>
        <tr>
          <th>时间</th>
          <th>类型</th>
          <th>级别</th>
          <th>消息</th>
          <th>关联</th>
        </tr>
      </thead>
      <tbody>
        ${logs.map((log) => `
          <tr>
            <td>${formatTime(log.createdAt)}</td>
            <td><span class="pill">${escapeHtml(log.type)}</span></td>
            <td>${escapeHtml(log.level || 'info')}</td>
            <td>${escapeHtml(log.message)}</td>
            <td>
              ${log.jobId ? `<div class="summary mono">任务 ${escapeHtml(log.jobId.slice(0, 8))}</div>` : ''}
              ${log.prKey ? `<div class="summary mono">${escapeHtml(log.prKey)}</div>` : ''}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  ` : '<div class="empty">暂无日志</div>';
}

function render() {
  $('#logsSettingsLink').hidden = !state.permissions?.canManagePlatform;
  $('#logsSubtitle').textContent = state.permissions?.canViewAllUsers
    ? '当前展示所有用户的日志'
    : '当前仅展示本人日志';
  renderFilters();
  renderLogsTable();
}

async function load() {
  state = await api('/api/state');
  if (state.initialized === false) {
    window.location.href = '/init.html';
    return;
  }
  render();
  setTimeout(() => load().catch(() => {}), state.jobs?.some((job) => job.status === 'running') ? 1500 : 10000);
}

$('#logTypeFilter')?.addEventListener('change', () => {
  renderLogsTable();
});

load().catch((error) => {
  document.body.innerHTML = `<main class="shell"><section class="panel settings-card"><h1>启动失败</h1><p class="error">${escapeHtml(error.message)}</p></section></main>`;
});
