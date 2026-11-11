import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(process.cwd());

for (const file of [
  'text-normalizer.test.ts',
  'segment-hover.test.ts',
  'pdf-page-scheduler.test.ts',
  'pdf-and-text-utils.test.ts',
  'pdf-text-normalizer.test.ts',
]) {
  jiti(path.resolve(__dirname, file));
}
