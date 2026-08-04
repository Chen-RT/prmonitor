let state = null;
let activeTab = 'awaiting';
let reloadTimer = null;
let repoPathPrKey = '';
const aiScrollState = new Map();

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

function roleLabel(role) {
  return {
    'super-admin': '超级管理员',
    admin: '管理员',
    user: '普通用户'
  }[role] || role || '普通用户';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function statusPill(status) {
  const className = status === 'APPROVED' || status === 'done' ? 'good' : status === 'UNAPPROVED' || status === 'queued' || status === 'running' ? 'warn' : status === 'failed' || status === 'blocked' ? 'bad' : '';
  return `<span class="pill ${className}">${escapeHtml(status || 'UNKNOWN')}</span>`;
}

function cleanLog(value) {
  return String(value || '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function latestLogText(value, maxLines = 7) {
  const lines = cleanLog(value);
  return lines.slice(-maxLines).join('\n') || '等待 AI 输出...';
}

function aiOutputPlayer(job) {
  const running = job.status === 'running';
  if (!running && !job.log) return '';
  return `
    <div class="ai-player ${running ? 'is-live' : ''}" data-ai-player="${escapeHtml(job.id)}" aria-live="${running ? 'polite' : 'off'}">
      <div class="ai-player-head">
        <span class="play-dot" aria-hidden="true"></span>
        <strong>${running ? 'AI 正在输出' : 'AI 输出记录'}</strong>
        <span>${running ? `更新 ${formatTime(job.liveLogUpdatedAt || job.startedAt)}` : `结束 ${formatTime(job.finishedAt)}`}</span>
      </div>
      <pre class="ai-output" data-ai-output="${escapeHtml(job.id)}">${escapeHtml(cleanLog(job.log).join('\n') || '等待 AI 输出...')}</pre>
    </div>
  `;
}

function captureAiScrollState() {
  document.querySelectorAll('[data-ai-output]').forEach((output) => {
    const maxScroll = output.scrollHeight - output.clientHeight;
    const followsLatest = maxScroll <= 0 || maxScroll - output.scrollTop < 28;
    aiScrollState.set(output.dataset.aiOutput, {
      followsLatest,
      scrollTop: output.scrollTop
    });
  });
}

function restoreAiScrollState() {
  document.querySelectorAll('[data-ai-output]').forEach((output) => {
    const jobId = output.dataset.aiOutput;
    const job = state?.jobs?.find((item) => item.id === jobId);
    const saved = aiScrollState.get(jobId);
    const shouldFollow = job?.status === 'running' && saved?.followsLatest !== false;
    output.scrollTop = shouldFollow ? output.scrollHeight : saved?.scrollTop || 0;
  });
}

function isCurrentReviewTaskDone(pr) {
  return pr.latestReviewJob?.status === 'done' && pr.latestReviewJob.reviewedCommit === pr.fromCommit;
}

function reviewResultLabel(result) {
  return {
    'comments-posted': '已发布 inline comment',
    'no-findings': '未发现需要评论的问题',
    failed: '评审未完成',
    blocked: '评审已阻塞'
  }[result] || result || '';
}

function reviewResultClass(result) {
  return result === 'comments-posted' || result === 'no-findings'
    ? 'good'
    : result === 'failed' || result === 'blocked'
      ? 'error'
      : '';
}

function prReviewHint(pr) {
  const job = pr.latestReviewJob;
  if (!isCurrentReviewTaskDone(pr)) return '';
  if (job.reviewResult === 'no-findings') {
    return '<div class="review-hint good">AI 已完成评审：未发现需要发布 inline comment 的确认问题。</div>';
  }
  if (job.reviewResult === 'comments-posted') {
    return '<div class="review-hint good">AI 已完成评审：已发布确认问题的 inline comment。</div>';
  }
  return '<div class="review-hint good">平台 review 任务已完成当前提交。</div>';
}

function prReviewAction(pr) {
  if (!pr.localRepoPath) {
    return `<button data-config-repo="${escapeHtml(pr.key)}">配置路径</button>`;
  }
  if (pr.activeReviewJob || isCurrentReviewTaskDone(pr)) {
    return '<button data-tab="jobs">查看任务</button>';
  }
  const label = ['failed', 'blocked'].includes(pr.latestReviewJob?.status) ? '重新 review' : '创建 review';
  return `<button data-review="${escapeHtml(pr.key)}">${label}</button>`;
}

function reviewedSortTime(pr) {
  return Date.parse(pr.platformReviewedAt || pr.latestSelfCommentAt || pr.updatedAt || pr.lastSeenAt || pr.importedAt || 0) || 0;
}

function renderStats() {
  const items = [
    ['待处理', state.stats.awaiting],
    ['已评未 Approve', state.stats.reviewedUnapproved],
    ['已 Approve', state.stats.approved],
    ['已导入', state.stats.imported],
    ['排队任务', state.stats.queued],
    ['运行中', state.stats.running]
  ];
  $('#stats').innerHTML = items.map(([label, value]) => `
    <div class="stat">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `).join('');
}

function renderSettings() {
  $('#tokenLine').textContent = state.token
    ? `已读取本地 token：${state.token.displayName || state.token.username}，更新于 ${formatTime(state.token.updatedAt)}`
    : '未找到本地 Bitbucket token';
  $('#userScopedHint').textContent = `当前用户：${state.currentUser.displayName}。PR、Review 任务、仓库路径映射和 Bitbucket 身份按用户隔离；超级管理员可查看全部用户数据。`;
  const canManagePlatform = Boolean(state.permissions?.canManagePlatform);
  const canManageUsers = Boolean(state.permissions?.canManageUsers);
  $('#settingsNavLink').hidden = !canManagePlatform;
  $('#settingsWideLink').hidden = !canManagePlatform;
  $('#usersNavLink').hidden = !canManageUsers;
  $('#userManageMenuLink').hidden = !canManageUsers;
  $('#schedulerBox').innerHTML = `
    <div>定时任务：${state.scheduler.running ? '运行中' : '已停止'}</div>
    <div>自动评审：${state.settings.autoReviewEnabled ? '已启用' : '已关闭'}</div>
    <div>轮询间隔：${escapeHtml(state.settings.intervalMinutes)} 分钟</div>
    <div>上次执行：${formatTime(state.scheduler.lastRunAt)}</div>
    <div>下次执行：${formatTime(state.scheduler.nextRunAt)}</div>
    ${state.scheduler.lastError ? `<div class="error">错误：${escapeHtml(state.scheduler.lastError)}</div>` : ''}
  `;
}

function renderUserMenu() {
  const user = state.currentUser;
  $('#userAvatar').textContent = (user.displayName || user.username || 'U').trim().slice(0, 1).toUpperCase();
  $('#userButtonText').textContent = user.displayName || user.username;
  $('#currentUserName').textContent = user.displayName || user.username;
  $('#currentUserMeta').textContent = `${user.username || user.id} · ${roleLabel(user.role)}`;
  $('#switchUserSelect').innerHTML = state.users.map((item) => `
    <option value="${escapeHtml(item.id)}" ${item.id === user.id ? 'selected' : ''}>
      ${escapeHtml(item.displayName)}（${escapeHtml(roleLabel(item.role))}）
    </option>
  `).join('');
}

function prRows(prs) {
  if (!prs.length) return '<div class="empty">暂无数据</div>';
  return `
    <table class="table">
      <thead>
        <tr>
          <th>PR</th>
          <th>作者</th>
          <th>状态</th>
          <th>分支</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${prs.map((pr) => `
          <tr>
            <td>
              <div class="mono">${escapeHtml(pr.displayKey || `${pr.project}/${pr.repo}#${pr.id}`)}</div>
              ${state.permissions?.canViewAllUsers ? `<div class="summary">归属：${escapeHtml(pr.ownerDisplayName || pr.ownerUserId)}</div>` : ''}
              <div class="summary">本地仓库：${escapeHtml(pr.localRepoPath || '未配置')}</div>
              <div class="title">${escapeHtml(pr.title)}</div>
              <div class="summary">${escapeHtml(pr.summary).slice(0, 260)}</div>
            </td>
            <td>${escapeHtml(pr.author)}</td>
            <td>
              ${statusPill(pr.reviewerStatus)}
              ${pr.selfCommentCount && pr.currentReviewValid ? '<div class="summary">当前提交已检测到本人评论</div>' : ''}
              ${pr.selfCommentCount && pr.reviewedByMe && !pr.currentReviewValid && !isCurrentReviewTaskDone(pr) ? '<div class="summary error">本人评论后有新提交，需重新评审</div>' : ''}
              ${pr.platformReviewCurrent && !pr.selfCommentCount ? '<div class="summary good">平台 AI 已评审当前提交</div>' : ''}
              ${prReviewHint(pr)}
              ${['failed', 'blocked'].includes(pr.latestReviewJob?.status) ? '<div class="summary error">上次平台 review 任务未完成</div>' : ''}
              ${pr.selfCommentCount ? `<div class="summary">评论 ${escapeHtml(pr.selfCommentCount)} 条，最近 ${formatTime(pr.latestSelfCommentAt)}</div>` : ''}
              ${pr.latestCodeChangeAt ? `<div class="summary">最近代码变更 ${formatTime(pr.latestCodeChangeAt)}</div>` : ''}
              ${pr.reviewSignalError ? `<div class="summary error">${escapeHtml(pr.reviewSignalError)}</div>` : ''}
              <div class="summary">${escapeHtml(pr.state)}</div>
            </td>
            <td>
              <div class="mono">${escapeHtml(pr.fromBranch || '-')}</div>
              <div class="summary">to ${escapeHtml(pr.toBranch || '-')}</div>
            </td>
            <td>
              <div class="row-actions">
                <button data-open="${escapeHtml(pr.url)}">打开</button>
                ${prReviewAction(pr)}
                ${pr.statusBucket === 'reviewed-unapproved' ? `<button class="approve-button" data-approve="${escapeHtml(pr.key)}">Approve</button>` : ''}
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function jobRows(jobs) {
  if (!jobs.length) return '<div class="empty">暂无 review 任务</div>';
  return `
    <table class="table job-table">
      <colgroup>
        <col class="job-col-task" />
        <col class="job-col-status" />
        <col class="job-col-time" />
        <col class="job-col-actions" />
      </colgroup>
      <thead>
        <tr>
          <th>任务</th>
          <th>状态</th>
          <th>时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${jobs.map((job) => {
          const canRun = ['queued', 'failed', 'blocked'].includes(job.status);
          const runLabel = job.status === 'running' ? '执行中' : job.status === 'done' ? '已完成' : job.status === 'queued' ? '执行' : '重试';
          const pr = (state.prs || []).find((item) => item.key === job.prKey);
          return `
          <tr>
            <td>
              <div class="mono">${escapeHtml(job.prDisplayKey || `${job.project}/${job.repo}#${job.prKey.split('#')[1]}`)}</div>
              <div class="summary">任务 ID：${escapeHtml(job.id.slice(0, 8))}</div>
              ${state.permissions?.canViewAllUsers ? `<div class="summary">归属：${escapeHtml(job.ownerDisplayName || job.ownerUserId)}</div>` : ''}
              <div class="title">${escapeHtml(job.title)}</div>
            </td>
            <td>
              ${statusPill(job.status)}
              <div class="summary">${escapeHtml(job.reason)}</div>
              ${job.reviewResult ? `<div class="review-hint ${reviewResultClass(job.reviewResult)}">结果：${escapeHtml(reviewResultLabel(job.reviewResult))}</div>` : ''}
            </td>
            <td>
              <div>创建：${formatTime(job.createdAt)}</div>
              <div class="summary">结束：${formatTime(job.finishedAt)}</div>
            </td>
            <td>
              <div class="row-actions">
                <button data-run-job="${escapeHtml(job.id)}" ${canRun ? '' : 'disabled'}>${runLabel}</button>
                <button data-open="${escapeHtml(job.prUrl)}">打开 PR</button>
                <button data-open="/logs.html">查看事件日志</button>
                ${pr && !pr.localRepoPath ? `<button data-config-repo="${escapeHtml(pr.key)}">配置路径</button>` : ''}
                <button class="danger-button" data-delete-job="${escapeHtml(job.id)}">${job.status === 'running' ? '取消并删除' : '删除'}</button>
              </div>
            </td>
          </tr>
          ${job.log ? `
            <tr class="job-output-row">
              <td colspan="4">${aiOutputPlayer(job)}</td>
            </tr>
          ` : ''}
        `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function renderContent() {
  const prs = state.prs || [];
  if (activeTab === 'jobs') {
    $('#content').innerHTML = jobRows(state.jobs || []);
    return;
  }
  const filtered = prs.filter((pr) => {
    if (activeTab === 'awaiting') return pr.statusBucket === 'awaiting' && !pr.activeReviewJob && !isCurrentReviewTaskDone(pr);
    if (activeTab === 'reviewed-unapproved') return pr.statusBucket === 'reviewed-unapproved';
    if (activeTab === 'approved') return pr.statusBucket === 'reviewed';
    return pr.source === 'imported';
  });
  if (activeTab === 'reviewed-unapproved') {
    filtered.sort((a, b) => reviewedSortTime(b) - reviewedSortTime(a));
  }
  $('#content').innerHTML = prRows(filtered);
}

function render() {
  captureAiScrollState();
  renderStats();
  renderSettings();
  renderUserMenu();
  renderContent();
  restoreAiScrollState();
}

async function load() {
  state = await api('/api/state');
  if (state.initialized === false) {
    window.location.href = '/init.html';
    return;
  }
  render();
  scheduleLoad();
}

async function mutate(path, body = {}, method = 'POST') {
  try {
    const result = await api(path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    state = result.state || result;
    render();
    scheduleLoad();
    return result;
  } catch (error) {
    window.alert(error.message);
    throw error;
  }
}

function openRepoPathModal(prKey) {
  const pr = (state.prs || []).find((item) => item.key === prKey);
  repoPathPrKey = prKey;
  const suggestion = pr?.localRepoPath || (pr?.repo ? `/path/to/${pr.repo}` : '');
  $('#repoPathPrMeta').textContent = `${pr?.displayKey || prKey} · ${pr?.title || '为当前 PR 选择可读取的本地仓库目录。'}`;
  $('#repoPathInput').value = suggestion;
  $('#repoPathSaveMapping').checked = true;
  $('#repoPathModal').hidden = false;
  window.setTimeout(() => $('#repoPathInput').focus(), 0);
}

function closeRepoPathModal() {
  repoPathPrKey = '';
  $('#repoPathModal').hidden = true;
}

async function saveRepoPath() {
  const trimmed = $('#repoPathInput').value.trim();
  if (!trimmed) {
    $('#repoPathInput').focus();
    return;
  }
  await mutate('/api/prs/local-repo-path', {
    prKey: repoPathPrKey,
    localRepoPath: trimmed,
    saveAsMapping: $('#repoPathSaveMapping').checked
  });
  closeRepoPathModal();
}

function scheduleLoad() {
  if (reloadTimer) clearTimeout(reloadTimer);
  const hasRunningJob = Boolean(state?.jobs?.some((job) => job.status === 'running'));
  reloadTimer = setTimeout(() => {
    load().catch(() => scheduleLoad());
  }, hasRunningJob ? 1500 : 10000);
}

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('[data-tab]');
  if (tab) {
    activeTab = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item.dataset.tab === activeTab));
    renderContent();
    return;
  }

  const open = event.target.closest('[data-open]');
  if (open) {
    window.open(open.dataset.open, '_blank', 'noopener,noreferrer');
    return;
  }

  const review = event.target.closest('[data-review]');
  if (review) {
    await mutate('/api/jobs', { prKey: review.dataset.review });
    activeTab = 'jobs';
    document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item.dataset.tab === activeTab));
    renderContent();
    return;
  }

  const configRepo = event.target.closest('[data-config-repo]');
  if (configRepo) {
    openRepoPathModal(configRepo.dataset.configRepo);
    return;
  }

  const approve = event.target.closest('[data-approve]');
  if (approve) {
    if (!window.confirm('确认 approve 这个 PR 吗？')) return;
    await mutate('/api/prs/approve', { prKey: approve.dataset.approve });
    activeTab = 'approved';
    document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item.dataset.tab === activeTab));
    renderContent();
    return;
  }

  const runJob = event.target.closest('[data-run-job]');
  if (runJob) {
    if (runJob.disabled) return;
    runJob.disabled = true;
    runJob.textContent = '启动中';
    await mutate(`/api/jobs/${runJob.dataset.runJob}/run`);
    return;
  }

  const deleteJob = event.target.closest('[data-delete-job]');
  if (deleteJob) {
    const isRunning = deleteJob.textContent.includes('取消');
    if (!window.confirm(isRunning ? '这个 review 任务正在运行，确认取消并删除吗？' : '确认删除这个 review 任务吗？')) return;
    deleteJob.disabled = true;
    deleteJob.textContent = isRunning ? '取消中' : '删除中';
    await mutate(`/api/jobs/${deleteJob.dataset.deleteJob}/delete`);
    activeTab = 'jobs';
    await load();
    return;
  }
});

$('#syncBtn').addEventListener('click', () => mutate('/api/sync'));
$('#runNowBtn').addEventListener('click', () => mutate('/api/scheduler/run-now'));

$('#userMenuBtn').addEventListener('click', () => {
  const dropdown = $('#userDropdown');
  const nextHidden = !dropdown.hidden ? true : false;
  dropdown.hidden = nextHidden;
  $('#userMenuBtn').setAttribute('aria-expanded', String(!nextHidden));
});

$('#switchUserBtn').addEventListener('click', async () => {
  await mutate('/api/users/switch', { userId: $('#switchUserSelect').value });
  $('#userDropdown').hidden = true;
});

$('#importBtn').addEventListener('click', async () => {
  await mutate('/api/import', {
    input: $('#importInput').value,
    localRepoPath: $('#importRepoPath').value.trim()
  });
  $('#importInput').value = '';
});

$('#repoPathForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!repoPathPrKey) return;
  await saveRepoPath();
});

$('#repoPathCancelBtn').addEventListener('click', closeRepoPathModal);

$('#repoPathModal').addEventListener('click', (event) => {
  if (event.target.id === 'repoPathModal') closeRepoPathModal();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#repoPathModal').hidden) closeRepoPathModal();
});

load().catch((error) => {
  document.body.innerHTML = `<main class="shell"><div class="panel controls"><h1>启动失败</h1><p class="error">${escapeHtml(error.message)}</p></div></main>`;
});
