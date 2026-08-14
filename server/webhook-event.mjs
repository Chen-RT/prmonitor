import { WebhookHttpError } from './webhook-signature.mjs';

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function participantName(participant = {}) {
  const user = participant.user || participant;
  return firstValue(user.name, user.slug, user.displayName, user.emailAddress, '');
}

export function parseBitbucketWebhookEvent(payload, { eventKey = '', deliveryId = '' } = {}) {
  const pullRequest = payload?.pullRequest || payload?.pullrequest || payload?.pull_request;
  const repository = payload?.repository || pullRequest?.toRef?.repository || pullRequest?.to_ref?.repository;
  const project = firstValue(repository?.project?.key, repository?.project?.name, payload?.project?.key);
  const repo = firstValue(repository?.slug, repository?.name);
  const prId = firstValue(pullRequest?.id, pullRequest?.number);
  if (!pullRequest || !project || !repo || prId === undefined) {
    throw new WebhookHttpError(400, 'Webhook 载荷缺少 pullRequest、仓库或 PR 标识。');
  }
  const fromRef = pullRequest.fromRef || pullRequest.from_ref || {};
  const toRef = pullRequest.toRef || pullRequest.to_ref || {};
  return {
    deliveryId: String(deliveryId || '').trim(),
    eventKey: String(eventKey || '').trim(),
    project: String(project).trim(),
    repo: String(repo).trim(),
    prId,
    title: String(pullRequest.title || `PR #${prId}`).trim(),
    fromCommit: String(firstValue(fromRef.latestCommit, fromRef.latest_commit, '')).trim(),
    fromBranch: String(firstValue(fromRef.displayId, fromRef.display_id, fromRef.id, '')).replace(/^refs\/heads\//, ''),
    toBranch: String(firstValue(toRef.displayId, toRef.display_id, toRef.id, '')).replace(/^refs\/heads\//, ''),
    author: participantName(pullRequest.author),
    reviewers: (pullRequest.reviewers || []).map(participantName).filter(Boolean),
    rawPullRequest: pullRequest
  };
}

export function branchMatches(branch, patterns = ['*']) {
  const target = String(branch || '').trim();
  return patterns.some((rawPattern) => {
    const pattern = String(rawPattern || '').trim();
    if (pattern === '*') return true;
    if (pattern.endsWith('*')) return target.startsWith(pattern.slice(0, -1));
    return target === pattern;
  });
}
