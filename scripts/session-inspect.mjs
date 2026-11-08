import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const file = process.argv[2];
const raw = readFileSync(file);
const text = zstdDecompressSync(raw).toString('utf8');
const lines = text.split(/\r?\n/).filter(Boolean);
console.log('lines', lines.length);
for (const line of lines.slice(0, 3)) {
  try {
    const row = JSON.parse(line);
    console.log('FIRST', JSON.stringify(row).slice(0, 1200));
  } catch {
    console.log('FIRST_RAW', line.slice(0, 400));
  }
}
for (const line of lines.slice(-8)) {
  try {
    const row = JSON.parse(line);
    const s = JSON.stringify(row);
    if (/PTY shell|agentPreset|preset|pwsh|shellPath|session_exit|error/i.test(s)) console.log('LAST', s.slice(0, 1500));
  } catch {}
}
