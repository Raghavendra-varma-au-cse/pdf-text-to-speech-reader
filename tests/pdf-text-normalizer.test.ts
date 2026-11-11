import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText } from '../lib/text-normalizer';

describe('PDF text normalisation', () => {
  it('preserves mathematical subtraction instead of treating it as hyphenation', () => {
    const segments = normalizeText([{ str: 'The value is x - y.' }], 1);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].text, 'The value is x - y.');
  });

  it('does not split a sentence at a colon', () => {
    const segments = normalizeText([{ str: 'The stages are: one, two and three.' }], 1);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].text, 'The stages are: one, two and three.');
  });

  it('keeps UTF-16 offsets aligned for emoji and astral characters', () => {
    const segments = normalizeText([{ str: 'Hello 😀 world.' }], 1);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].text, 'Hello 😀 world.');
    assert.equal(segments[0].spanFragments?.[0]?.text, 'Hello 😀 world.');
  });

  it('builds fragments for sentences that span multiple PDF text items', () => {
    const segments = normalizeText(
      [{ str: 'The quick' }, { str: ' brown fox.' }],
      2
    );
    assert.equal(segments.length, 1);
    assert.equal(segments[0].text, 'The quick brown fox.');
    assert.equal(segments[0].pageNumber, 2);
    assert.deepEqual(
      segments[0].spanFragments?.map((fragment) => fragment.spanId),
      ['page-2-span-0', 'page-2-span-1']
    );
  });

  it('splits multiple sentences that share one span into separate fragments', () => {
    const segments = normalizeText([{ str: 'First sentence. Second sentence.' }], 1);
    assert.equal(segments.length, 2);
    assert.equal(segments[0].spanFragments?.[0]?.text, 'First sentence.');
    assert.equal(segments[1].spanFragments?.[0]?.text, ' Second sentence.');
  });
});
