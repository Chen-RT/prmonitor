let platformState = null;
let standardsData = null;
let selectedStandardId = 'builtin-default';
let creatingStandard = false;
let draftStandard = null;
const extraRepositories = new Map();

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
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

function setStatus(selector, message, kind = 'ok') {
  const target = $(selector);
  target.textContent = message;
  target.className = `save-status ${kind}`;
}

function findByData(attribute, value) {
  return $$(`[${attribute}]`).find((element) => element.dataset[attribute.replace(/^data-/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] === value);
}

function config() {
  return standardsData.config;
}

function selectedStandard() {
  if (creatingStandard) return draftStandard;
  return config().standards[selectedStandardId] || config().standards[standardsData.builtinStandardId];
}

function standardOptions(selectedId = '', includeDefault = false) {
  const defaultStandard = config().standards[config().defaultStandardId];
  const options = includeDefault
    ? `<option value="">默认：${escapeHtml(defaultStandard.name)} v${defaultStandard.version}</option>`
    : '';
  return options + Object.values(config().standards)
    .filter((standard) => standard.enabled || standard.id === selectedId)
    .map((standard) => `
      <option value="${escapeHtml(standard.id)}" ${standard.id === selectedId ? 'selected' : ''}>
        ${escapeHtml(standard.name)} v${standard.version}${standard.enabled ? '' : '（已停用）'}
      </option>
    `).join('');
}

function renderStandardList() {
  const standards = Object.values(config().standards);
  const customCount = standards.filter((standard) => !standard.builtin).length;
  $('#standardCount').textContent = `${customCount} 个自定义标准`;
  $('#standardList').innerHTML = standards.map((standard) => {
    const isDefault = standard.id === config().defaultStandardId;
    const selected = !creatingStandard && standard.id === selectedStandardId;
    const bindingCount = Object.values(config().repoBindings)
      .filter((binding) => binding.standardId === standard.id).length;
    return `
      <button class="standard-list-item ${selected ? 'active' : ''}" type="button" data-standard-id="${escapeHtml(standard.id)}" role="option" aria-selected="${selected}">
        <span class="standard-list-title">
          <strong>${escapeHtml(standard.name)}</strong>
          ${isDefault ? '<span class="pill good">默认</span>' : ''}
          ${standard.enabled ? '' : '<span class="pill bad">停用</span>'}
        </span>
        <span>v${standard.version} · ${bindingCount} 个仓库</span>
      </button>
    `;
  }).join('');
}

function pathRulesFromForm() {
  return $$('[data-path-rule]').map((row) => ({
    pattern: row.querySelector('[data-path-pattern]').value.trim(),
    instructions: row.querySelector('[data-path-instructions]').value.trim()
  }));
}

function renderPathRules(pathRules = []) {
  $('#pathRulesList').innerHTML = pathRules.map((rule, index) => `
    <div class="path-rule-row" data-path-rule>
      <label>
        <span>路径模式</span>
        <input data-path-pattern maxlength="300" value="${escapeHtml(rule.pattern)}" placeholder="src/components/**" />
      </label>
      <label>
        <span>补充要求</span>
        <textarea data-path-instructions rows="2" maxlength="4000" placeholder="命中该路径时重点检查的内容">${escapeHtml(rule.instructions)}</textarea>
      </label>
      <button class="path-rule-remove" type="button" data-remove-path-rule="${index}" title="删除规则" aria-label="删除规则">×</button>
    </div>
  `).join('');
  $('#pathRuleCount').textContent = `${pathRules.length} / 50`;
}

function standardFromForm() {
  return {
    name: $('#standardName').value.trim(),
    description: $('#standardDescription').value.trim(),
    enabled: $('#standardEnabled').checked,
    minimumSeverity: document.querySelector('input[name="minimumSeverity"]:checked')?.value || 'P2',
    instructions: $('#standardInstructions').value.trim(),
    pathRules: pathRulesFromForm()
  };
}

function renderPromptPreview() {
  const standard = standardFromForm();
  const severityText = {
    P0: '只发布 P0 问题',
    P1: '发布 P0 和 P1 问题，不发布 P2',
    P2: '发布所有确认的 P0、P1 和 P2 问题'
  }[standard.minimumSeverity];
  const lines = [
    `仓库评审标准：${standard.name || '未命名标准'}`,
    `最低评论级别：${standard.minimumSeverity}，${severityText}。`
  ];
  if (standard.instructions) lines.push('', '通用评审要求：', standard.instructions);
  if (standard.pathRules.length) {
    lines.push('', '文件路径补充规则：');
    standard.pathRules.forEach((rule) => lines.push(`- ${rule.pattern || '(未填写路径)'}: ${rule.instructions || '(未填写要求)'}`));
  }
  $('#standardPromptPreview').textContent = lines.join('\n');
  $('#pathRuleCount').textContent = `${standard.pathRules.length} / 50`;
}

function renderStandardEditor() {
  const standard = selectedStandard();
  const readonly = Boolean(standard.builtin) && !creatingStandard;
  $('#standardEditorTitle').textContent = creatingStandard ? '新建评审标准' : standard.name;
  $('#standardEditorMeta').textContent = creatingStandard
    ? '保存后可绑定到仓库'
    : `${standard.id} · v${standard.version}${standard.builtin ? ' · 内置只读' : ''}`;
  $('#standardName').value = standard.name || '';
  $('#standardDescription').value = standard.description || '';
  $('#standardEnabled').checked = standard.enabled !== false;
  $(`input[name="minimumSeverity"][value="${standard.minimumSeverity || 'P2'}"]`).checked = true;
  $('#standardInstructions').value = standard.instructions || '';
  renderPathRules(standard.pathRules || []);
  $('#standardForm').querySelectorAll('input, textarea').forEach((control) => {
    control.disabled = readonly;
  });
  $('#addPathRuleBtn').disabled = readonly;
  $('#saveStandardBtn').hidden = readonly;
  $('#deleteStandardBtn').hidden = readonly || creatingStandard;
  $('#setDefaultStandardBtn').hidden = creatingStandard;
  $('#setDefaultStandardBtn').disabled = standard.id === config().defaultStandardId || !standard.enabled;
  $('#copyStandardBtn').hidden = creatingStandard;
  renderPromptPreview();
}

function allRepositories() {
  const repositories = new Map();
  for (const repository of standardsData.repositories || []) repositories.set(repository.key, repository);
  for (const [key, repository] of extraRepositories) repositories.set(key, repository);
  for (const key of Object.keys(config().repoBindings || {})) {
    if (!repositories.has(key)) {
      const [project, repo] = key.split('/');
      repositories.set(key, { key, project, repo });
    }
  }
  return [...repositories.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function renderBindings() {
  const bindings = config().repoBindings || {};
  const repositories = allRepositories();
  $('#bindingSummary').textContent = `${Object.keys(bindings).length} 个仓库已绑定，其他仓库使用默认标准`;
  if (!repositories.length) {
    $('#repositoryBindingsTable').innerHTML = '<div class="empty">暂无可配置仓库</div>';
    return;
  }
  $('#repositoryBindingsTable').innerHTML = `
    <table class="table review-binding-table">
      <thead><tr><th>仓库</th><th>执行用户 / 本地路径</th><th>评审标准</th><th>检测</th></tr></thead>
      <tbody>
        ${repositories.map((repository) => {
          const selectedId = bindings[repository.key]?.standardId || '';
          return `
            <tr>
              <td><strong class="mono">${escapeHtml(repository.key)}</strong></td>
              <td>
                <div>${escapeHtml(repository.ownerDisplayName || '未解析')}</div>
                <div class="summary mono">${escapeHtml(repository.localRepoPath || '未配置路径')}</div>
              </td>
              <td><select data-repo-binding="${escapeHtml(repository.key)}">${standardOptions(selectedId, true)}</select></td>
              <td>
                <button type="button" data-resolve-repository="${escapeHtml(repository.key)}">检测</button>
                <div class="summary" data-resolution-status="${escapeHtml(repository.key)}"></div>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function renderAll() {
  renderStandardList();
  renderStandardEditor();
  renderBindings();
}

function startNewStandard(source = null) {
  const base = source || {};
  creatingStandard = true;
  selectedStandardId = '';
  draftStandard = {
    name: source ? `${base.name} 副本` : '',
    description: base.description || '',
    enabled: true,
    minimumSeverity: base.minimumSeverity || 'P2',
    instructions: base.instructions || '',
    pathRules: (base.pathRules || []).map((rule) => ({ ...rule }))
  };
  renderAll();
  $('#standardName').focus();
}

$('#newStandardBtn').addEventListener('click', () => startNewStandard());
$('#copyStandardBtn').addEventListener('click', () => startNewStandard(selectedStandard()));

$('#standardList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-standard-id]');
  if (!button) return;
  selectedStandardId = button.dataset.standardId;
  creatingStandard = false;
  draftStandard = null;
  setStatus('#standardSaveStatus', '');
  renderAll();
});

$('#addPathRuleBtn').addEventListener('click', () => {
  const rules = pathRulesFromForm();
  if (rules.length >= 50) return;
  rules.push({ pattern: '', instructions: '' });
  renderPathRules(rules);
  renderPromptPreview();
  $('#pathRulesList [data-path-rule]:last-child [data-path-pattern]')?.focus();
});

$('#pathRulesList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-path-rule]');
  if (!button) return;
  const rules = pathRulesFromForm();
  rules.splice(Number(button.dataset.removePathRule), 1);
  renderPathRules(rules);
  renderPromptPreview();
});

$('#standardForm').addEventListener('input', renderPromptPreview);

$('#standardForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const beforeIds = new Set(Object.keys(config().standards));
  const standard = standardFromForm();
  const button = $('#saveStandardBtn');
  button.disabled = true;
  setStatus('#standardSaveStatus', '保存中...', 'busy');
  try {
    const endpoint = creatingStandard ? '/api/review-standards' : `/api/review-standards/${encodeURIComponent(selectedStandardId)}`;
    standardsData = await api(endpoint, {
      method: creatingStandard ? 'POST' : 'PUT',
      body: JSON.stringify(standard)
    });
    if (creatingStandard) {
      selectedStandardId = standardsData.createdStandardId
        || Object.keys(config().standards).find((id) => !beforeIds.has(id))
        || standardsData.builtinStandardId;
    }
    creatingStandard = false;
    draftStandard = null;
    renderAll();
    setStatus('#standardSaveStatus', '已保存');
  } catch (error) {
    setStatus('#standardSaveStatus', error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

$('#setDefaultStandardBtn').addEventListener('click', async () => {
  setStatus('#standardSaveStatus', '保存中...', 'busy');
  try {
    standardsData = await api('/api/review-standards/default', {
      method: 'POST',
      body: JSON.stringify({ standardId: selectedStandardId })
    });
    renderAll();
    setStatus('#standardSaveStatus', '已设为默认');
  } catch (error) {
    setStatus('#standardSaveStatus', error.message, 'error');
  }
});

$('#deleteStandardBtn').addEventListener('click', async () => {
  const standard = selectedStandard();
  if (!window.confirm(`确认删除评审标准“${standard.name}”吗？`)) return;
  setStatus('#standardSaveStatus', '删除中...', 'busy');
  try {
    standardsData = await api(`/api/review-standards/${encodeURIComponent(standard.id)}`, { method: 'DELETE' });
    selectedStandardId = standardsData.builtinStandardId;
    renderAll();
    setStatus('#standardSaveStatus', '已删除');
  } catch (error) {
    setStatus('#standardSaveStatus', error.message, 'error');
  }
});

$('#addRepositoryBindingBtn').addEventListener('click', () => {
  const project = $('#bindingProject').value.trim();
  const repo = $('#bindingRepo').value.trim();
  if (!project || !repo || project.includes('/') || repo.includes('/')) {
    setStatus('#bindingSaveStatus', '请填写有效的 Project 和仓库 slug', 'error');
    return;
  }
  const key = `${project}/${repo}`.toLowerCase();
  extraRepositories.set(key, { key, project, repo });
  $('#bindingProject').value = '';
  $('#bindingRepo').value = '';
  renderBindings();
  findByData('data-repo-binding', key)?.focus();
});

$('#saveBindingsBtn').addEventListener('click', async () => {
  const repoBindings = {};
  $$('[data-repo-binding]').forEach((select) => {
    if (select.value) repoBindings[select.dataset.repoBinding] = select.value;
  });
  const button = $('#saveBindingsBtn');
  button.disabled = true;
  setStatus('#bindingSaveStatus', '保存中...', 'busy');
  try {
    standardsData = await api('/api/review-standards/bindings', {
      method: 'POST',
      body: JSON.stringify({ repoBindings })
    });
    renderAll();
    setStatus('#bindingSaveStatus', '已保存');
  } catch (error) {
    setStatus('#bindingSaveStatus', error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

$('#repositoryBindingsTable').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-resolve-repository]');
  if (!button) return;
  const key = button.dataset.resolveRepository;
  const [project, repo] = key.split('/');
  const status = findByData('data-resolution-status', key);
  button.disabled = true;
  status.textContent = '检测中...';
  try {
    const result = await api('/api/review-standards/resolve', {
      method: 'POST',
      body: JSON.stringify({ project, repo })
    });
    status.textContent = result.ok
      ? `${result.standard.name} v${result.standard.version} · ${result.source === 'repository' ? '仓库绑定' : '默认'}`
      : result.reason;
    status.className = `summary ${result.ok ? 'good' : 'error'}`;
  } catch (error) {
    status.textContent = error.message;
    status.className = 'summary error';
  } finally {
    button.disabled = false;
  }
});

async function load() {
  platformState = await api('/api/state');
  if (platformState.initialized === false) {
    window.location.href = '/init.html';
    return;
  }
  if (!platformState.permissions?.canManagePlatform) {
    window.location.href = '/';
    return;
  }
  standardsData = await api('/api/review-standards');
  selectedStandardId = standardsData.config.defaultStandardId;
  renderAll();
}

load().catch((error) => {
  document.body.innerHTML = `<main class="shell"><section class="panel settings-card"><h1>启动失败</h1><p class="error">${escapeHtml(error.message)}</p></section></main>`;
});
