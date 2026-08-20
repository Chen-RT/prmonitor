let state = null;
let webhookData = null;

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

function setStatus(message, type = '') {
  const target = $('#webhookSaveStatus');
  target.textContent = message;
  target.className = `save-status ${type}`.trim();
}

function repoOwnersFromText(value) {
  const result = {};
  for (const line of String(value || '').split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) throw new Error(`仓库归属格式无效：${trimmed}`);
    const repo = trimmed.slice(0, separator).trim();
    const userId = trimmed.slice(separator + 1).trim();
    if (!repo || !userId) throw new Error(`仓库归属格式无效：${trimmed}`);
    result[repo] = userId;
  }
  return result;
}

function settingsFromForm() {
  const acceptedEvents = [
    $('#webhookEventOpened').checked ? 'pr:opened' : '',
    $('#webhookEventUpdated').checked ? 'pr:from_ref_updated' : ''
  ].filter(Boolean);
  return {
    enabled: $('#webhookEnabled').checked,
    publicBaseUrl: $('#webhookPublicBaseUrl').value.trim(),
    secretEnvName: $('#webhookSecretEnvName').value.trim(),
    acceptedEvents,
    targetBranches: $('#webhookTargetBranches').value.split(/\n+/).map((item) => item.trim()).filter(Boolean),
    action: $('#webhookAction').value,
    repoOwners: repoOwnersFromText($('#webhookRepoOwners').value),
    maxBodyBytes: Number($('#webhookMaxBodyBytes').value)
  };
}

function updateEndpointPreview() {
  const baseUrl = $('#webhookPublicBaseUrl').value.trim().replace(/\/+$/, '');
  $('#webhookEndpointUrl').value = baseUrl ? `${baseUrl}/api/webhooks/bitbucket` : '';
  const localOnly = /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?$/i.test(baseUrl);
  $('#webhookNetworkNotice').classList.toggle('danger', localOnly);
}

function renderSettings() {
  const settings = webhookData.settings;
  $('#webhookEnabled').checked = Boolean(settings.enabled);
  $('#webhookPublicBaseUrl').value = settings.publicBaseUrl || '';
  $('#webhookEndpointUrl').value = settings.endpointUrl || '';
  $('#webhookSecretEnvName').value = settings.secretEnvName || 'PR_MONITOR_WEBHOOK_SECRET';
  $('#webhookEventOpened').checked = settings.acceptedEvents.includes('pr:opened');
  $('#webhookEventUpdated').checked = settings.acceptedEvents.includes('pr:from_ref_updated');
  $('#webhookTargetBranches').value = settings.targetBranches.join('\n');
  $('#webhookAction').value = settings.action;
  $('#webhookMaxBodyBytes').value = settings.maxBodyBytes;
  $('#webhookRepoOwners').value = Object.entries(settings.repoOwners || {})
    .map(([repo, userId]) => `${repo}=${userId}`)
    .join('\n');
  $('#webhookSecretStatus').innerHTML = settings.secretConfigured ? `
    <strong>Secret 已配置</strong>
    <span>服务进程已检测到环境变量 <code>${escapeHtml(settings.secretEnvName)}</code>，原值不会返回页面。</span>
  ` : `
    <strong>Secret 未配置</strong>
    <span>请在启动 PR Monitor 的进程环境中设置 <code>${escapeHtml(settings.secretEnvName)}</code>，然后重启服务。</span>
  `;
  $('#webhookOwnerHelp').innerHTML = `
    <strong>可用执行用户</strong>
    ${(webhookData.users || []).map((user) => `
      <span><code>${escapeHtml(user.id)}</code> · ${escapeHtml(user.displayName || user.username)} · Token ${user.hasBitbucketToken ? '已配置' : '未配置'}</span>
    `).join('') || '<span>暂无用户。</span>'}
  `;
  const firstRepo = Object.keys(settings.repoOwners || {})[0] || '';
  if (firstRepo && !$('#webhookTestProject').value && !$('#webhookTestRepo').value) {
    const [project, repo] = firstRepo.split('/');
    $('#webhookTestProject').value = project || '';
    $('#webhookTestRepo').value = repo || '';
  }
  updateEndpointPreview();
}

function outcomeClass(outcome) {
  if (['accepted', 'synced'].includes(outcome)) return 'good';
  if (String(outcome).includes('duplicate') || String(outcome).includes('ignored')) return 'warn';
  if (['rejected', 'failed'].includes(outcome)) return 'bad';
  return '';
}

function shortCommit(value) {
  return value ? String(value).slice(0, 10) : '-';
}

function renderDeliveries(deliveries) {
  $('#webhookDeliveriesTable').innerHTML = deliveries.length ? `
    <table class="table webhook-delivery-table">
      <thead>
        <tr>
          <th>时间</th>
          <th>结果</th>
          <th>事件 / 仓库</th>
          <th>PR / commit</th>
          <th>原因 / 任务</th>
        </tr>
      </thead>
      <tbody>
        ${deliveries.map((delivery) => `
          <tr>
            <td>${formatTime(delivery.createdAt)}</td>
            <td><span class="pill ${outcomeClass(delivery.outcome)}">${escapeHtml(delivery.outcome || delivery.type)}</span></td>
            <td>
              <div>${escapeHtml(delivery.eventKey || '-')}</div>
              <div class="summary mono">${escapeHtml(delivery.project && delivery.repo ? `${delivery.project}/${delivery.repo}` : '-')}</div>
            </td>
            <td>
              <div>${delivery.prId ? `#${escapeHtml(delivery.prId)}` : '-'}</div>
              <div class="summary mono">${escapeHtml(shortCommit(delivery.fromCommit))}</div>
            </td>
            <td>
              <div>${escapeHtml(delivery.reason || '-')}</div>
              ${delivery.jobId ? `<div class="summary mono">任务 ${escapeHtml(delivery.jobId.slice(0, 8))}</div>` : ''}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  ` : '<div class="empty">尚未收到 Webhook 投递</div>';
}

function renderTestResults(result) {
  $('#webhookTestResults').innerHTML = (result.checks || []).map((check) => `
    <div class="environment-item ${check.ok ? 'ok' : 'bad'}">
      <strong>${escapeHtml(check.id)}</strong>
      <span>${escapeHtml(check.message)}</span>
    </div>
  `).join('');
}

async function loadDeliveries() {
  const result = await api('/api/webhooks/deliveries?limit=100');
  renderDeliveries(result.deliveries || []);
}

async function load() {
  state = await api('/api/state');
  if (state.initialized === false) {
    window.location.href = '/init.html';
    return;
  }
  if (!state.permissions?.canManagePlatform) {
    window.location.href = '/';
    return;
  }
  webhookData = await api('/api/webhooks/settings');
  renderSettings();
  await loadDeliveries();
  setTimeout(() => loadDeliveries().catch(() => {}), 10000);
}

$('#webhookPublicBaseUrl')?.addEventListener('input', updateEndpointPreview);

$('#webhookSettingsForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  setStatus('保存中...', 'busy');
  try {
    webhookData = await api('/api/webhooks/settings', {
      method: 'POST',
      body: JSON.stringify(settingsFromForm())
    });
    renderSettings();
    setStatus('Webhook 设置已保存');
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

$('#webhookTestBtn')?.addEventListener('click', async () => {
  const button = $('#webhookTestBtn');
  button.disabled = true;
  setStatus('检测中...', 'busy');
  try {
    const result = await api('/api/webhooks/test', {
      method: 'POST',
      body: JSON.stringify({
        settings: settingsFromForm(),
        sample: {
          project: $('#webhookTestProject').value.trim(),
          repo: $('#webhookTestRepo').value.trim(),
          toBranch: $('#webhookTestBranch').value.trim(),
          fromCommit: $('#webhookTestCommit').value.trim()
        }
      })
    });
    renderTestResults(result);
    setStatus(result.ok ? '配置检测通过（未产生任务）' : `检测完成：${result.outcome}`, result.ok ? '' : 'error');
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

load().catch((error) => {
  document.body.innerHTML = `<main class="shell"><section class="panel settings-card"><h1>启动失败</h1><p class="error">${escapeHtml(error.message)}</p></section></main>`;
});
