#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  try {
    const mod = await import('english-words');
    const getWords = mod?.default?.getWords ?? mod.getWords;
    if (typeof getWords !== 'function') throw new Error('english-words.getWords missing');
    const words = await new Promise((resolve, reject) => {
      try { getWords((arr) => resolve(arr)); } catch (e) { reject(e); }
    });
    const filtered = (Array.isArray(words) ? words : [])
      .filter((w) => typeof w === 'string')
      .map((w) => w.toLowerCase())
      .filter((w) => /^[a-z]{3,}$/.test(w));

    const outDir = resolve(__dirname, '../amplify/functions/shared');
    const outFile = resolve(outDir, 'english-words.json');
    await mkdir(outDir, { recursive: true });
    await writeFile(outFile, JSON.stringify(filtered), 'utf8');
    console.log(`Wrote ${filtered.length} words to ${outFile}`);
  } catch (e) {
    console.error('Failed to build dictionary from english-words:', e);
    process.exit(1);
  }
}

await main();

