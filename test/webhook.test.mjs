import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  normalizeWebhookSettings,
  validateWebhookSettingsInput,
  webhookSettingsForClient
} from '../server/webhook-config.mjs';
import { branchMatches, parseBitbucketWebhookEvent } from '../server/webhook-event.mjs';
import { parseJsonBuffer, verifyBitbucketWebhookSignature } from '../server/webhook-signature.mjs';

const payload = Buffer.from(JSON.stringify({ pullRequest: { id: 93 } }));

test('normalizes webhook settings without exposing secret values', () => {
  const settings = normalizeWebhookSettings({
    enabled: true,
    publicBaseUrl: 'https://review.example.com/',
    secretEnvName: 'TEST_WEBHOOK_SECRET',
    targetBranches: ['main', 'release/*'],
    repoOwners: { 'I18N/repo': 'admin' }
  });
  const client = webhookSettingsForClient(settings, { TEST_WEBHOOK_SECRET: 'do-not-return' });
  assert.equal(client.endpointUrl, 'https://review.example.com/api/webhooks/bitbucket');
  assert.equal(client.secretConfigured, true);
  assert.equal(JSON.stringify(client).includes('do-not-return'), false);
});

test('rejects unsafe secret environment names', () => {
  assert.throws(() => validateWebhookSettingsInput({ secretEnvName: 'BAD-NAME' }), /格式无效/);
});

test('verifies exact raw-body HMAC signatures', () => {
  const secret = 'test-secret';
  const signature = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  assert.equal(verifyBitbucketWebhookSignature(payload, signature, secret), true);
  assert.equal(verifyBitbucketWebhookSignature(Buffer.from(`${payload} `), signature, secret), false);
  assert.equal(verifyBitbucketWebhookSignature(payload, 'sha256=abc', secret), false);
  assert.equal(verifyBitbucketWebhookSignature(payload, '', secret), false);
});

test('parses JSON buffers and reports invalid payloads', () => {
  assert.deepEqual(parseJsonBuffer(Buffer.from('{"ok":true}')), { ok: true });
  assert.throws(() => parseJsonBuffer(Buffer.from('{')), (error) => error.statusCode === 400);
});

test('matches exact, prefix wildcard and global branch rules', () => {
  assert.equal(branchMatches('main', ['main']), true);
  assert.equal(branchMatches('release/7.0', ['release/*']), true);
  assert.equal(branchMatches('feature/demo', ['release/*']), false);
  assert.equal(branchMatches('anything', ['*']), true);
});

test('normalizes Bitbucket Server pull request events', () => {
  const event = parseBitbucketWebhookEvent({
    repository: { slug: 'plugin-bi-finebi-cli', project: { key: 'I18N' } },
    pullRequest: {
      id: 93,
      title: 'Add webhook review',
      fromRef: { displayId: 'feature/webhook', latestCommit: 'abc123' },
      toRef: { displayId: 'release/7.0' },
      author: { user: { name: 'alice', displayName: 'Alice' } },
      reviewers: [{ user: { name: 'reviewer-one' } }]
    }
  }, { eventKey: 'pr:opened', deliveryId: 'delivery-1' });
  assert.deepEqual(event, {
    deliveryId: 'delivery-1',
    eventKey: 'pr:opened',
    project: 'I18N',
    repo: 'plugin-bi-finebi-cli',
    prId: 93,
    title: 'Add webhook review',
    fromCommit: 'abc123',
    fromBranch: 'feature/webhook',
    toBranch: 'release/7.0',
    author: 'alice',
    reviewers: ['reviewer-one'],
    rawPullRequest: {
      id: 93,
      title: 'Add webhook review',
      fromRef: { displayId: 'feature/webhook', latestCommit: 'abc123' },
      toRef: { displayId: 'release/7.0' },
      author: { user: { name: 'alice', displayName: 'Alice' } },
      reviewers: [{ user: { name: 'reviewer-one' } }]
    }
  });
});

test('rejects webhook events without repository identity', () => {
  assert.throws(() => parseBitbucketWebhookEvent({ pullRequest: { id: 1 } }), (error) => error.statusCode === 400);
});
