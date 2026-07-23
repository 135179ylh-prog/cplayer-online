import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js');
const destinationDirectory = resolve(root, 'js', 'vendor');
const destination = resolve(destinationDirectory, 'supabase.js');

await mkdir(destinationDirectory, { recursive: true });
await copyFile(source, destination);
// Keep the generated vendor artifact compatible with the repository text gate.
const bundled = await readFile(destination, 'utf8');
const normalized = bundled.replace(/[\t ]+(?=\r?$)/gm, '');
if (normalized !== bundled) await writeFile(destination, normalized, 'utf8');
console.log('Supabase browser bundle copied to ' + destination);
