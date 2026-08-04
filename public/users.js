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

function roleLabel(role) {
  return {
    'super-admin': '超级管理员',
    admin: '管理员',
    user: '普通用户'
  }[role] || role || '普通用户';
}

function setStatus(selector, text, kind = 'ok') {
  const target = $(selector);
  if (!target) return;
  target.textContent = text;
  target.className = `save-status ${kind}`;
}

function userPayload(prefix) {
  return {
    displayName: $(`#${prefix}DisplayName`).value.trim(),
    username: $(`#${prefix}Username`).value.trim(),
    role: $(`#${prefix}Role`).value,
    bitbucketNames: $(`#${prefix}BitbucketNames`).value.trim(),
    repoPathMappings: $(`#${prefix}RepoPathMappings`).value.trim()
  };
}

function renderUsers() {
  $('#usersSubtitle').textContent = `${state.currentUser.displayName} · ${roleLabel(state.currentUser.role)}`;
  $('#usersTable').innerHTML = `
    <table class="table user-table">
      <thead>
        <tr>
          <th>用户</th>
          <th>身份</th>
          <th>Bitbucket 身份</th>
          <th>仓库路径</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${(state.users || []).map((user) => `
          <tr data-user-row="${escapeHtml(user.id)}">
            <td>
              <input data-field="displayName" value="${escapeHtml(user.displayName || '')}" />
              <input data-field="username" value="${escapeHtml(user.username || '')}" />
              <div class="summary mono">${escapeHtml(user.id)}</div>
            </td>
            <td>
              <select data-field="role">
                <option value="user" ${user.role === 'user' ? 'selected' : ''}>普通用户</option>
                <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>管理员</option>
                <option value="super-admin" ${user.role === 'super-admin' ? 'selected' : ''}>超级管理员</option>
              </select>
            </td>
            <td>
              <textarea data-field="bitbucketNames" rows="4">${escapeHtml(user.bitbucketNames || '')}</textarea>
            </td>
            <td>
              <textarea data-field="repoPathMappings" rows="4">${escapeHtml(user.repoPathMappings || '')}</textarea>
            </td>
            <td>
              <div class="row-actions">
                <button data-save-user="${escapeHtml(user.id)}">保存</button>
                <button class="danger-button" data-delete-user="${escapeHtml(user.id)}" ${user.id === state.currentUser.id ? 'disabled' : ''}>删除</button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function load() {
  state = await api('/api/state');
  if (state.initialized === false) {
    window.location.href = '/init.html';
    return;
  }
  if (!state.permissions?.canManageUsers) {
    window.location.href = state.permissions?.canManagePlatform ? '/settings.html' : '/user-settings.html';
    return;
  }
  renderUsers();
}

$('#createUserForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  setStatus('#createUserStatus', '创建中...', 'busy');
  try {
    const result = await api('/api/users', {
      method: 'POST',
      body: JSON.stringify(userPayload('new'))
    });
    state = result.state || result;
    event.currentTarget.reset();
    renderUsers();
    setStatus('#createUserStatus', '已创建');
  } catch (error) {
    setStatus('#createUserStatus', error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

document.addEventListener('click', async (event) => {
  const save = event.target.closest('[data-save-user]');
  if (save) {
    const row = save.closest('[data-user-row]');
    const userId = save.dataset.saveUser;
    const payload = {};
    row.querySelectorAll('[data-field]').forEach((field) => {
      payload[field.dataset.field] = field.value;
    });
    save.disabled = true;
    save.textContent = '保存中';
    try {
      const result = await api(`/api/users/${encodeURIComponent(userId)}`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      state = result.state || result;
      renderUsers();
    } catch (error) {
      window.alert(error.message);
      save.disabled = false;
      save.textContent = '保存';
    }
    return;
  }

  const remove = event.target.closest('[data-delete-user]');
  if (remove) {
    if (!window.confirm('确认删除这个用户吗？该用户的历史 PR 会被归档。')) return;
    remove.disabled = true;
    remove.textContent = '删除中';
    try {
      const result = await api(`/api/users/${encodeURIComponent(remove.dataset.deleteUser)}`, {
        method: 'DELETE'
      });
      state = result.state || result;
      renderUsers();
    } catch (error) {
      window.alert(error.message);
      remove.disabled = false;
      remove.textContent = '删除';
    }
  }
});

load().catch((error) => {
  document.body.innerHTML = `<main class="shell"><section class="panel settings-card"><h1>启动失败</h1><p class="error">${escapeHtml(error.message)}</p></section></main>`;
});
