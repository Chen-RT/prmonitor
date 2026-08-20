import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUILTIN_REVIEW_STANDARD_ID,
  canonicalRepoKey,
  normalizeReviewStandards,
  resolveReviewStandard,
  reviewStandardPromptSection,
  snapshotReviewStandard,
  validateRepoBindingsInput,
  validateReviewStandardInput
} from '../server/review-standard.mjs';

test('normalizes review standards with a built-in default', () => {
  const config = normalizeReviewStandards();
  assert.equal(config.defaultStandardId, BUILTIN_REVIEW_STANDARD_ID);
  assert.equal(config.standards[BUILTIN_REVIEW_STANDARD_ID].builtin, true);
  assert.equal(config.standards[BUILTIN_REVIEW_STANDARD_ID].minimumSeverity, 'P2');
});

test('resolves exact repository bindings case-insensitively', () => {
  const custom = validateReviewStandardInput({
    name: 'Frontend',
    minimumSeverity: 'P1',
    instructions: 'Check state lifecycles.',
    pathRules: []
  }, { id: 'frontend' });
  const config = normalizeReviewStandards({
    defaultStandardId: BUILTIN_REVIEW_STANDARD_ID,
    standards: { frontend: custom },
    repoBindings: { 'I18N/Plugin-BI': { standardId: 'frontend' } }
  });
  const resolution = resolveReviewStandard(config, 'i18n', 'plugin-bi');
  assert.equal(resolution.ok, true);
  assert.equal(resolution.source, 'repository');
  assert.equal(resolution.standard.id, 'frontend');
  assert.equal(canonicalRepoKey('I18N', 'Plugin-BI'), 'i18n/plugin-bi');
});

test('uses the default standard when a repository has no binding', () => {
  const resolution = resolveReviewStandard(normalizeReviewStandards(), 'TEST', 'demo');
  assert.equal(resolution.ok, true);
  assert.equal(resolution.source, 'default');
  assert.equal(resolution.standard.id, BUILTIN_REVIEW_STANDARD_ID);
});

test('blocks invalid explicit bindings instead of silently falling back', () => {
  const config = normalizeReviewStandards({
    repoBindings: { 'TEST/demo': { standardId: 'missing' } }
  });
  const resolution = resolveReviewStandard(config, 'TEST', 'demo');
  assert.equal(resolution.ok, false);
  assert.equal(resolution.source, 'repository');
  assert.match(resolution.reason, /不存在/);
});

test('validates repository bindings and disabled standards', () => {
  const disabled = validateReviewStandardInput({
    name: 'Disabled',
    enabled: false,
    minimumSeverity: 'P2',
    pathRules: []
  }, { id: 'disabled' });
  const config = normalizeReviewStandards({ standards: { disabled } });
  assert.throws(
    () => validateRepoBindingsInput({ 'TEST/demo': 'disabled' }, config),
    /不能绑定已停用/
  );
  assert.throws(
    () => validateRepoBindingsInput({ invalid: BUILTIN_REVIEW_STANDARD_ID }, config),
    /PROJECT\/repo/
  );
});

test('creates immutable prompt snapshots with versioned rules', () => {
  const standard = validateReviewStandardInput({
    name: 'Strict frontend',
    minimumSeverity: 'P1',
    instructions: 'Trace persisted state.',
    pathRules: [{ pattern: 'src/**', instructions: 'Check async cleanup.' }]
  }, { id: 'strict' });
  const snapshot = snapshotReviewStandard(standard, 'repository');
  const prompt = reviewStandardPromptSection(snapshot);
  assert.equal(snapshot.id, 'strict');
  assert.equal(snapshot.hash.length, 64);
  assert.match(prompt, /Strict frontend v1/);
  assert.match(prompt, /发布 P0 和 P1/);
  assert.match(prompt, /src\/\*\*/);
});

test('increments a standard version on update', () => {
  const existing = validateReviewStandardInput({
    name: 'Initial',
    minimumSeverity: 'P2',
    pathRules: []
  }, { id: 'versioned' });
  const updated = validateReviewStandardInput({
    name: 'Updated',
    minimumSeverity: 'P1',
    pathRules: []
  }, { id: 'versioned', existing });
  assert.equal(existing.version, 1);
  assert.equal(updated.version, 2);
  assert.equal(updated.createdAt, existing.createdAt);
});
