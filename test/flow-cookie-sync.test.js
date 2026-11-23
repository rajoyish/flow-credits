import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchFlowBalance } from '../lib/flow-cookie-sync.js';

const session = (email) => JSON.stringify({ SNlM0e: 'test-token', cfb2h: 'build', oPEP7c: email });

test('signed-out HTML reports a reconnect requirement without requesting a balance', async () => {
  let requests = 0;
  await assert.rejects(fetchFlowBalance('fake-cookie', 'tracked@example.com', async () => {
    requests++;
    return new Response('<a href="https://accounts.google.com/ServiceLogin">Sign in</a>');
  }), { code: 'AUTH_REQUIRED' });
  assert.equal(requests, 1);
});

for (const email of ['other@example.com', '']) {
  test(`rejects ${email ? 'a different' : 'an unidentified'} account before reading credits`, async () => {
    let requests = 0;
    await assert.rejects(fetchFlowBalance('fake-cookie', 'tracked@example.com', async () => {
      requests++;
      return new Response(session(email));
    }), { code: 'ACCOUNT_MISMATCH', message: /different or unidentified Google account/ });
    assert.equal(requests, 1);
  });
}

test('an authenticated account still returns its credit balance and plan', async () => {
  let requests = 0;
  const reading = await fetchFlowBalance('fake-cookie', 'TRACKED@example.com', async (url, options) => {
    requests++;
    if (requests === 1) return new Response(session('tracked@example.com'));
    assert.equal(options.method, 'POST');
    assert.equal(options.body.get('at'), 'test-token');
    assert.equal(new URL(url).searchParams.get('rpcids'), 'nzlxg');
    return new Response(JSON.stringify([['wrb.fr', 'nzlxg', JSON.stringify([50, 3, null, null, null, 50, [1795219200, 0]])]]));
  });
  assert.equal(requests, 2);
  assert.equal(reading.email, 'tracked@example.com');
  assert.equal(reading.available_credits, 50);
  assert.equal(reading.reset_period, 'daily');
  assert.equal(reading.plan_name, 'Free');
});
