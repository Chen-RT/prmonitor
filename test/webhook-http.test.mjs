import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('webhook HTTP entry verifies signatures and protects secret values', async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pr-monitor-webhook-test-'));
  const repoDir = path.join(dataDir, 'demo-repo');
  await mkdir(path.join(repoDir, '.git'), { recursive: true });
  const secret = 'http-test-secret';
  let latestCommit = 'abc123';
  const fakeBitbucket = createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer fake-token') {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ errors: [{ message: 'Unauthorized' }] }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      id: 1,
      title: 'Demo',
      state: 'OPEN',
      fromRef: { displayId: 'feature/demo', latestCommit },
      toRef: {
        displayId: 'main',
        latestCommit: 'target123',
        repository: { slug: 'demo', project: { key: 'TEST' } }
      },
      author: { user: { name: 'alice', displayName: 'Alice' } },
      reviewers: []
    }));
  });
  await new Promise((resolve, reject) => {
    fakeBitbucket.once('error', reject);
    fakeBitbucket.listen(0, '127.0.0.1', resolve);
  });
  const fakeBitbucketPort = fakeBitbucket.address().port;
  process.env.PR_MONITOR_DATA_DIR = dataDir;
  process.env.PR_MONITOR_WEBHOOK_SECRET = secret;
  await writeFile(path.join(dataDir, 'store.json'), JSON.stringify({
    initialized: true,
    settings: {
      baseUrl: `http://127.0.0.1:${fakeBitbucketPort}`,
      webhook: {
        enabled: true,
        publicBaseUrl: 'https://review.example.com',
        secretEnvName: 'PR_MONITOR_WEBHOOK_SECRET',
        acceptedEvents: ['pr:opened', 'pr:from_ref_updated'],
        targetBranches: ['main'],
        action: 'queue',
        repoOwners: {},
        maxBodyBytes: 1048576
      }
    },
    currentUserId: 'admin',
    users: {
      admin: {
        id: 'admin',
        username: 'admin',
        displayName: 'Admin',
        role: 'admin',
        bitbucketToken: 'fake-token',
        repoPathMappings: `TEST/demo=${repoDir}`
      }
    },
    prs: {},
    jobs: [],
    events: [],
    logs: [],
    scheduler: {}
  }));

  const { startServer } = await import(`../server.mjs?http-test=${Date.now()}`);
  const started = await startServer({ port: 0, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${started.port}`;
  context.after(async () => {
    await new Promise((resolve, reject) => started.server.close((error) => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => fakeBitbucket.close((error) => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
    delete process.env.PR_MONITOR_DATA_DIR;
    delete process.env.PR_MONITOR_WEBHOOK_SECRET;
  });

  await context.test('management API returns only secret configuration status', async () => {
    const response = await fetch(`${baseUrl}/api/webhooks/settings`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.settings.secretConfigured, true);
    assert.equal(JSON.stringify(body).includes(secret), false);
  });

  const eventPayload = Buffer.from(JSON.stringify({
    repository: { slug: 'demo', project: { key: 'TEST' } },
    pullRequest: {
      id: 1,
      title: 'Demo',
      fromRef: { displayId: 'feature/demo', latestCommit: 'abc123' },
      toRef: { displayId: 'main' }
    }
  }));

  await context.test('invalid signatures return 401', async () => {
    const response = await fetch(`${baseUrl}/api/webhooks/bitbucket`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Event-Key': 'pr:opened',
        'X-Hub-Signature': `sha256=${'0'.repeat(64)}`
      },
      body: eventPayload
    });
    assert.equal(response.status, 401);
  });

  await context.test('valid unsupported events are ignored without external calls', async () => {
    const signature = createHmac('sha256', secret).update(eventPayload).digest('hex');
    const response = await fetch(`${baseUrl}/api/webhooks/bitbucket`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Event-Key': 'repo:refs_changed',
        'X-Request-Id': 'unsupported-event-1',
        'X-Hub-Signature': `sha256=${signature}`
      },
      body: eventPayload
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).reason, 'event-not-accepted');
  });

  async function sendSignedWebhook(deliveryId) {
    const signature = createHmac('sha256', secret).update(eventPayload).digest('hex');
    return fetch(`${baseUrl}/api/webhooks/bitbucket`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Event-Key': 'pr:opened',
        'X-Request-Id': deliveryId,
        'X-Hub-Signature': `sha256=${signature}`
      },
      body: eventPayload
    });
  }

  await context.test('accepted delivery creates one queue job', async () => {
    const response = await sendSignedWebhook('accepted-delivery-1');
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.outcome, 'accepted');
    assert.ok(body.jobId);
  });

  await context.test('same delivery and same commit are both deduplicated', async () => {
    const repeatedDelivery = await sendSignedWebhook('accepted-delivery-1');
    assert.equal(repeatedDelivery.status, 200);
    assert.equal((await repeatedDelivery.json()).outcome, 'duplicate-delivery');

    const repeatedCommit = await sendSignedWebhook('accepted-delivery-2');
    assert.equal(repeatedCommit.status, 200);
    assert.equal((await repeatedCommit.json()).outcome, 'duplicate-commit');
  });

  await context.test('a new source commit creates a new job', async () => {
    latestCommit = 'def456';
    const response = await sendSignedWebhook('accepted-delivery-3');
    assert.equal(response.status, 202);
    assert.equal((await response.json()).outcome, 'accepted');

    const stateResponse = await fetch(`${baseUrl}/api/state`);
    const state = await stateResponse.json();
    assert.equal(state.jobs.length, 2);
    assert.deepEqual(new Set(state.jobs.map((job) => job.targetCommit)), new Set(['abc123', 'def456']));
  });

  await context.test('non-JSON content types return 415', async () => {
    const response = await fetch(`${baseUrl}/api/webhooks/bitbucket`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-Event-Key': 'pr:opened' },
      body: eventPayload
    });
    assert.equal(response.status, 415);
  });
});
