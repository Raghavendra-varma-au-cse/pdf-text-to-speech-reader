import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { countWords, buildWordPrefix } from '../lib/text-metrics';
import { toSpeechText } from '../lib/math-speech';
import { computeFitScale, capRenderDpr, getRenderedPageBudget } from '../lib/pdf-viewer-utils';
import { formatFileSize, fingerprintFile } from '../lib/document-history';

describe('word metrics', () => {
  it('counts words without allocating arrays', () => {
    assert.equal(countWords('  hello   world  '), 2);
    assert.equal(countWords('one\ntwo\tthree'), 3);
    assert.equal(countWords(''), 0);
    assert.equal(countWords('— —'), 2);
  });

  it('builds a prefix table for O(1) playback metrics', () => {
    const { prefix, total } = buildWordPrefix([
      { text: 'one two' },
      { text: 'three' },
      { text: 'four five six' },
    ]);
    assert.equal(total, 6);
    assert.deepEqual([...prefix], [0, 2, 3, 6]);
  });
});

describe('math speech', () => {
  it('speaks superscripts and equations as words', () => {
    const spoken = toSpeechText('x^2 + y^2 = z^2');
    assert.match(spoken, /x squared/);
    assert.match(spoken, /plus/);
    assert.match(spoken, /equals/);
  });

  it('keeps subtraction when the PDF line is joined', () => {
    assert.equal(toSpeechText('a - b'), 'a minus b');
  });

  it('expands LaTeX fractions and square roots', () => {
    assert.equal(toSpeechText('\\frac{1}{2}'), '1 over 2');
    assert.match(toSpeechText('\\sqrt{9} = 3'), /square root of 9/);
  });

  it('expands unicode powers, subscripts and Greek letters', () => {
    assert.equal(toSpeechText('x²'), 'x squared');
    assert.match(toSpeechText('H₂O'), /H sub 2 O/);
    assert.match(toSpeechText('α + β'), /alpha plus beta/);
  });

  it('leaves prose, URLs and hyphenated words alone', () => {
    const prose = 'The state-of-the-art reader is read/write friendly.';
    assert.equal(toSpeechText(prose), prose);
    const url = 'https://example.com/search?q=a=b';
    assert.equal(toSpeechText(url), url);
  });
});

describe('PDF viewer utilities', () => {
  it('fits a US Letter page to a mobile viewport', () => {
    const scale = computeFitScale(375, 612);
    assert.ok(scale > 0.5 && scale < 0.7);
  });

  it('clamps fit zoom to the configured range', () => {
    assert.equal(computeFitScale(10, 612), 0.4);
    assert.equal(computeFitScale(100_000, 100), 3.5);
  });

  it('caps the canvas backing store on huge zoom levels', () => {
    const dpr = capRenderDpr(4000, 6000, 3, 12_000_000);
    assert.ok(dpr < 1);
    assert.ok(dpr >= 0.5);
  });

  it('keeps a modest page budget for big documents', () => {
    const budget = getRenderedPageBudget(500);
    assert.ok(budget >= 6 && budget <= 12);
  });
});

describe('document history helpers', () => {
  it('formats sizes for the history list', () => {
    assert.equal(formatFileSize(0), '0 B');
    assert.equal(formatFileSize(2048), '2.0 KB');
    assert.equal(formatFileSize(5 * 1024 * 1024), '5.0 MB');
  });

  it('fingerprints files by identity fields', () => {
    const file = new File(['hello'], 'book.pdf', {
      type: 'application/pdf',
      lastModified: 123,
    });
    assert.match(fingerprintFile(file), /^book\.pdf\u00005\u0000123\u0000application\/pdf$/);
  });
});
