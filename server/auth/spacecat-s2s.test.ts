import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTokenFresh } from './spacecat-s2s.js';

test('isTokenFresh: null expiry is never fresh', () => {
  assert.equal(isTokenFresh(null, 1000, 0), false);
});

test('isTokenFresh: fresh when now is before expiry minus buffer', () => {
  // expires at 10_000, 1s buffer → fresh until 9_000
  assert.equal(isTokenFresh(10_000, 1_000, 8_999), true);
});

test('isTokenFresh: stale once inside the buffer window', () => {
  assert.equal(isTokenFresh(10_000, 1_000, 9_000), false);
  assert.equal(isTokenFresh(10_000, 1_000, 9_500), false);
});
