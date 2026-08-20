import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('review standard management persists bindings and immutable job snapshots', async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pr-monitor-standard-test-'));
  const prKey = 'admin:TEST/demo#1';
  const doneJobId = 'done-job';
  process.env.PR_MONITOR_DATA_DIR = dataDir;
  await writeFile(path.join(dataDir, 'store.json'), JSON.stringify({
    initialized: true,
    settings: {},
    currentUserId: 'admin',
    users: {
      admin: {
        id: 'admin',
        username: 'admin',
        displayName: 'Admin',
        role: 'admin',
        repoPathMappings: ''
      }
    },
    prs: {
      [prKey]: {
        key: prKey,
        displayKey: 'TEST/demo#1',
        ownerUserId: 'admin',
        ownerDisplayName: 'Admin',
        project: 'TEST',
        repo: 'demo',
        id: '1',
        title: 'Demo',
        url: 'https://bitbucket.example.com/projects/TEST/repos/demo/pull-requests/1',
        fromCommit: 'abc123',
        statusBucket: 'awaiting'
      }
    },
    jobs: [{
      id: doneJobId,
      ownerUserId: 'admin',
      prKey,
      prDisplayKey: 'TEST/demo#1',
      title: 'Demo',
      status: 'done',
      targetCommit: 'abc123',
      reviewedCommit: 'abc123',
      reviewResult: 'no-findings',
      createdAt: '2026-08-14T00:00:00.000Z',
      finishedAt: '2026-08-14T00:01:00.000Z'
    }],
    events: [],
    logs: [],
    scheduler: {}
  }));

  const { startServer } = await import(`../server.mjs?review-standard-http=${Date.now()}`);
  const started = await startServer({ port: 0, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${started.port}`;
  context.after(async () => {
    await new Promise((resolve, reject) => started.server.close((error) => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
    delete process.env.PR_MONITOR_DATA_DIR;
  });

  async function request(apiPath, options = {}) {
    const response = await fetch(`${baseUrl}${apiPath}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const body = await response.json();
    return { response, body };
  }

  const initial = await request('/api/review-standards');
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.config.defaultStandardId, 'builtin-default');

  const invalid = await request('/api/review-standards', {
    method: 'POST',
    body: JSON.stringify({ minimumSeverity: 'P3' })
  });
  assert.equal(invalid.response.status, 400);
  assert.match(invalid.body.error, /名称不能为空/);

  const created = await request('/api/review-standards', {
    method: 'POST',
    body: JSON.stringify({
      id: 'frontend-strict',
      name: '前端严格评审',
      description: 'Frontend lifecycle rules',
      enabled: true,
      minimumSeverity: 'P1',
      instructions: '检查状态同步和持久化。',
      pathRules: [{ pattern: 'src/**', instructions: '检查异步清理。' }]
    })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.createdStandardId, 'frontend-strict');
  assert.equal(created.body.config.standards['frontend-strict'].version, 1);

  const bound = await request('/api/review-standards/bindings', {
    method: 'POST',
    body: JSON.stringify({ repoBindings: { 'TEST/demo': 'frontend-strict' } })
  });
  assert.equal(bound.response.status, 200);
  assert.equal(bound.body.config.repoBindings['test/demo'].standardId, 'frontend-strict');

  const resolved = await request('/api/review-standards/resolve', {
    method: 'POST',
    body: JSON.stringify({ project: 'test', repo: 'DEMO' })
  });
  assert.equal(resolved.response.status, 200);
  assert.equal(resolved.body.source, 'repository');
  assert.equal(resolved.body.snapshot.version, 1);

  const rerunV1 = await request(`/api/jobs/${doneJobId}/review-with-latest-standard`, {
    method: 'POST',
    body: '{}'
  });
  assert.equal(rerunV1.response.status, 200);
  assert.notEqual(rerunV1.body.job.id, doneJobId);
  assert.equal(rerunV1.body.job.reviewStandardSnapshot.id, 'frontend-strict');
  assert.equal(rerunV1.body.job.reviewStandardSnapshot.version, 1);
  const queuedV1Id = rerunV1.body.job.id;

  const updated = await request('/api/review-standards/frontend-strict', {
    method: 'PUT',
    body: JSON.stringify({
      name: '前端严格评审',
      description: 'Updated',
      enabled: true,
      minimumSeverity: 'P1',
      instructions: '检查状态同步、持久化和兼容路径。',
      pathRules: []
    })
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.config.standards['frontend-strict'].version, 2);

  const stateAfterUpdate = await request('/api/state');
  const queuedV1 = stateAfterUpdate.body.jobs.find((job) => job.id === queuedV1Id);
  assert.equal(queuedV1.reviewStandardSnapshot.version, 1);
  const prState = stateAfterUpdate.body.prs.find((pr) => pr.key === prKey);
  assert.equal(prState.latestReviewJob.reviewStandardSnapshot.version, 1);

  const referencedDelete = await request('/api/review-standards/frontend-strict', { method: 'DELETE' });
  assert.equal(referencedDelete.response.status, 409);

  const deletedJob = await request(`/api/jobs/${queuedV1Id}`, { method: 'DELETE' });
  assert.equal(deletedJob.response.status, 200);
  const rerunV2 = await request(`/api/jobs/${doneJobId}/review-with-latest-standard`, {
    method: 'POST',
    body: '{}'
  });
  assert.equal(rerunV2.response.status, 200);
  assert.equal(rerunV2.body.job.reviewStandardSnapshot.version, 2);

  const stored = JSON.parse(await readFile(path.join(dataDir, 'store.json'), 'utf8'));
  assert.equal(stored.settings.reviewStandards.repoBindings['test/demo'].standardId, 'frontend-strict');
  assert.equal(stored.jobs.find((job) => job.id === rerunV2.body.job.id).reviewStandardSnapshot.version, 2);
});
