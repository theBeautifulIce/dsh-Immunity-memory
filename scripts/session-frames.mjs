import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const file = process.argv[2];
const raw = readFileSync(file);
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const offsets = [];
let at = 0;
while (true) {
  const i = raw.indexOf(magic, at);
  if (i < 0) break;
  offsets.push(i);
  at = i + 4;
}
console.log('bytes', raw.length, 'frames', offsets.length, 'offsets', offsets.slice(0, 10));
const rows = [];
for (let i = 0; i < offsets.length; i++) {
  const start = offsets[i];
  const end = offsets[i + 1] ?? raw.length;
  const slice = raw.subarray(start, end);
  let text;
  try {
    text = zstdDecompressSync(slice).toString('utf8');
  } catch (error) {
    console.log('frame', i, 'failed', error.message);
    continue;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { rows.push({ type: 'raw', line: line.slice(0, 300) }); }
  }
}
console.log('rows', rows.length);
console.log('types', Object.fromEntries([...new Set(rows.map(r => r.type))].map(t => [t, rows.filter(r => r.type === t).length])));
for (const row of rows) {
  const s = JSON.stringify(row);
  if (/PTY shell|shell exited|agentPreset|preset|pwsh|shellPath|capture|tool_result|error/i.test(s)) {
    console.log('ROW', s.slice(0, 2000));
  }
}
