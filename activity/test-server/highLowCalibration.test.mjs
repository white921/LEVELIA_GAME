import assert from 'node:assert/strict';
import test from 'node:test';
import { BASELINE_RTP_PERCENT, correctionForTarget, estimatedRtpPercent, targetPercentToPpm } from '../server/highLowCalibration.mjs';

test('target RTP is converted to a coefficient, not used directly as a payout percentage', () => {
  for (const target of [0.0001,95,98,100,101,102,1000]) {
    const coefficient=correctionForTarget(targetPercentToPpm(target));
    assert.ok(Math.abs(estimatedRtpPercent(coefficient)-target) <= BASELINE_RTP_PERCENT/1_000_000);
  }
  assert.ok(correctionForTarget(targetPercentToPpm(101)) < 1_000_000);
  assert.ok(correctionForTarget(targetPercentToPpm(98)) < 980000);
  for (const value of [0,-1,1001,'98',98.12345,Infinity]) assert.throws(()=>targetPercentToPpm(value));
});
