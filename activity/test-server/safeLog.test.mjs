import assert from 'node:assert/strict';
import test from 'node:test';
import { errorMetadata } from '../server/safeLog.mjs';

test('error logs exclude SQL, credentials and nested response bodies', () => {
  const error = Object.assign(new Error('secret database address'), {
    errno: 1062, statusCode: 500,
    sql: 'private user data', code: 'untrusted remote string',
    cause: { headers: { authorization: 'Bearer secret' } },
    response: { token: 'secret' },
  });
  assert.deepEqual(errorMetadata(error), { errno: 1062, statusCode: 500 });
  assert.deepEqual(errorMetadata({ errno: 'secret', statusCode: 'secret' }), {});
  assert.deepEqual(errorMetadata(null), {});
});
