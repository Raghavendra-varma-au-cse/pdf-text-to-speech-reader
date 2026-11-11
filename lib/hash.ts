/**
 * Stable, content-based hash used for the TTS audio cache and IndexedDB keys.
 *
 * The old implementation used a single signed 32-bit integer, so two different
 * sentences could silently share cached audio. This keeps two independent
 * 32-bit lanes plus the text length, which makes accidental collisions far
 * less likely while staying cheap enough to run on every sentence.
 */
export function hashString(str: string): string {
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;

  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return `${(h2 >>> 0).toString(36)}-${(h1 >>> 0).toString(36)}-${str.length.toString(36)}`;
}

export interface AudioCacheKeyParts {
  engine: string;
  voice: string;
  speed: number;
  serverUrl?: string;
  text: string;
}

/**
 * Cache keys must include the synthesis parameters. Kokoro bakes speed and
 * voice into the generated audio, so hashing only the text would replay the
 * wrong voice/speed after the user changes either one.
 */
export function audioCacheKey({
  engine,
  voice,
  speed,
  serverUrl = '',
  text,
}: AudioCacheKeyParts): string {
  return hashString(
    `${engine}|${serverUrl}|${voice}|${Number(speed).toFixed(2)}|${text}`
  );
}
