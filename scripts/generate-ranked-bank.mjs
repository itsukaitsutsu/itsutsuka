// Keep Worker data byte-for-byte aligned with the browser's CSV parser.
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
const source = ts.transpileModule(readFileSync('shared/vocabulary.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { parseCsv } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const seen = new Set();
const words = ['N1','N2','N3','N4','N5'].flatMap(tier => parseCsv(readFileSync(`attached_assets/data/vocab-${tier.toLowerCase()}.csv`, 'utf8'), tier.toLowerCase(), tier)).filter(word => {
  const key = `${word.expression}|${word.reading}`;
  if (seen.has(key)) return false;
  seen.add(key); return true;
});
writeFileSync('worker/rankedBank.json', JSON.stringify(words));
console.log(`Generated ${words.length} ranked words from the shared parser.`);
