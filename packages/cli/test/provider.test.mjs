import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider, providerImplements } from '../src/provider.mjs';

test('mieweb target resolves the built-in opensource-server provider', async () => {
  // root outside the repo: the provider must resolve from the CLI's own deps.
  const p = await resolveProvider({ target: 'mieweb', root: '/', targetConfig: {} });
  assert.equal(p.name, 'opensource-server');
  assert.ok(p.supports('mieweb'));
});

test('verbs the provider lacks fall back to the legacy path', async () => {
  const p = await resolveProvider({ target: 'mieweb', root: '/', targetConfig: {} });
  for (const v of ['deploy', 'destroy', 'whoami', 'login', 'logout']) assert.ok(providerImplements(p, v), v);
  for (const v of ['dev', 'tail']) assert.equal(providerImplements(p, v), false, v);
});
