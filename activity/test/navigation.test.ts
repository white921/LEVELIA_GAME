import assert from 'node:assert/strict';
import test from 'node:test';
import { hashForRoute, routeFromHash } from '../src/navigation.js';

test('maps known game hash to high-low route', () => {
  assert.equal(routeFromHash('#high-low'), 'high-low');
  assert.equal(hashForRoute('high-low'), '#high-low');
});

test('maps empty and unknown hashes back to the lobby', () => {
  assert.equal(routeFromHash(''), 'lobby');
  assert.equal(routeFromHash('#roulette'), 'lobby');
  assert.equal(hashForRoute('lobby'), '#lobby');
});
