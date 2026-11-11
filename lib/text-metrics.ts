/** Count whitespace-separated words without allocating an array per sentence. */
export function countWords(text: string): number {
  let count = 0;
  let inWord = false;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // space, tab, CR, LF, form feed, vertical tab, NBSP and other unicode spaces
    const isSpace =
      code === 32 ||
      code === 9 ||
      code === 10 ||
      code === 13 ||
      code === 12 ||
      code === 11 ||
      code === 0xa0 ||
      code === 0x1680 ||
      (code >= 0x2000 && code <= 0x200a) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x202f ||
      code === 0x205f ||
      code === 0x3000;

    if (isSpace) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      count++;
    }
  }

  return count;
}

/** Prefix word counts so playback metrics stay O(1) per sentence. */
export function buildWordPrefix(segments: { text: string }[]): {
  prefix: Uint32Array;
  total: number;
} {
  const prefix = new Uint32Array(segments.length + 1);
  let total = 0;

  for (let i = 0; i < segments.length; i++) {
    prefix[i] = total;
    total += countWords(segments[i].text);
  }
  prefix[segments.length] = total;

  return { prefix, total };
}
