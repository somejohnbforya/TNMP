// Copy Stockfish engine files from @lichess-org/stockfish-web to public/engine/.
// NNUE weights aren't copied: the browser fetches them at runtime through the
// worker's /nnue/ proxy and keeps them in the Cache API (see src/engine.js).
import { cpSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'node_modules', '@lichess-org', 'stockfish-web');
const dest = join(root, 'public', 'engine');

mkdirSync(dest, { recursive: true });

// Net sizes as the browser downloads them: the proxy's upstream fetch undoes
// the CDN's compression, so the 75 MiB full net arrives as 94 MiB.
// sf_19: full strength, one net (nn-1a298aa575a0, 94 MiB)
// sf_19_smallnet: lite, one net (nn-61e7af4bb97d, 1.1 MiB)
const files = ['sf_19.js', 'sf_19.wasm', 'sf_19_smallnet.js', 'sf_19_smallnet.wasm'];
for (const file of files) {
    cpSync(join(src, file), join(dest, file));
}
console.log(`Copied ${files.length} engine files to public/engine/`);
