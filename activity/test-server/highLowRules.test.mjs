import assert from 'node:assert/strict';
import test from 'node:test';
import { drawRandomCard, drawActionableCard, resolveServerGuess } from '../server/highLowRules.mjs';
const samples = values => n => { const value = values.shift(); assert.ok(value >= 0 && value < n); return value; };

test('every independent draw has all 52 possibilities, including repeated identical cards', () => {
  assert.equal(new Set(Array.from({length:52}, (_,i) => drawRandomCard(() => i))).size,52);
  assert.equal(drawRandomCard(() => 7),'spades-9');
  assert.equal(drawRandomCard(() => 7),'spades-9');
  for(const value of [-1,52,NaN,1.5]) assert.throws(() => drawRandomCard(() => value));
  const tie = resolveServerGuess({currentCardId:'spades-9',guess:'higher',randomIndex:()=>7});
  assert.equal(tie.result,'tie'); assert.equal(tie.currentAfterCardId,'spades-9');
  assert.equal('deck' in tie,false);
});

test('skips ace and two using fresh independent draws', () => {
  assert.deepEqual(drawActionableCard(samples([12,0,12,7])), {cardId:'spades-9', autoDrawnCards:['spades-A','spades-2','spades-A']});
});

test('resolves a guess and independently auto-draws after a revealed ace', () => {
  const result=resolveServerGuess({currentCardId:'clubs-7',guess:'higher',randomIndex:samples([12,0,3])});
  assert.equal(result.result,'win'); assert.equal(result.revealedCardId,'spades-A');
  assert.deepEqual(result.autoDrawnCardIds,['spades-2','spades-5']); assert.equal(result.currentAfterCardId,'spades-5');
});

test('fate shift replaces a losing draw with a fresh uniformly chosen winning card', () => {
  const result=resolveServerGuess({currentCardId:'clubs-7',guess:'higher',randomIndex:samples([1,0,0])});
  assert.equal(result.fateShifted,true);assert.equal(result.result,'win');
  assert.equal(result.revealedCardId,'spades-3');assert.equal(result.finalCardId,'spades-8');
  const loss=resolveServerGuess({currentCardId:'clubs-7',guess:'higher',randomIndex:samples([1,999])});
  assert.equal(loss.result,'loss');assert.equal(loss.fateShifted,false);
});
