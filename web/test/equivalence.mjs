// Compares the JavaScript generator with the C# console tool on an export folder: every transaction must give the
// same file (apart from the "Generated ..." line).
//   node web/test/equivalence.mjs <export folder> <folder written by MiiXRay.exe --folder ... --all --out ...>
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjectPath } from '../src/sources.js';
import { FolderSource } from './folder-source.js';
import { DependencyResolver } from '../src/resolver.js';
import { generateCode } from '../src/codefile.js';

const [exportFolder, csharpFolder] = process.argv.slice(2).map((path) => resolve(path));

if (!exportFolder || !csharpFolder) {
  console.error('usage: node web/test/equivalence.mjs <export folder> <C# output folder>');
  process.exit(2);
}

const runtime = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/Generate/RuntimeSource.txt'), 'utf8').replace(/^﻿/, '');
const files = [];

(function walk(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const full = join(folder, entry.name);

    if (entry.isDirectory()) {
      walk(full);
    } else {
      files.push(full);
    }
  }
})(exportFolder);

const source = new FolderSource(exportFolder, files.map((full) => ({
  path: relative(exportFolder, full).replace(/\\/g, '/'),
  read: async () => readFileSync(full, 'utf8'),
})));
const normalize = (text) => text.replace(/^﻿/, '').replace(/^\/\/ Generated .*$/m, '// Generated');
const transactions = files.filter((full) => full.toLowerCase().endsWith('.trx')).map((full) => relative(exportFolder, full)).sort();
let equal = 0;
const different = [];

for (const transaction of transactions) {
  const graph = await new DependencyResolver(source).resolve(transaction);

  if (!graph) {
    different.push(transaction + ': not resolved');
    continue;
  }

  const result = generateCode(graph, 'export folder ' + exportFolder, runtime, new Date());
  const expectedFile = join(csharpFolder, ObjectPath.folder(transaction.replace(/\\/g, '/')), result.rootName + '.xray.cs');

  if (!existsSync(expectedFile)) {
    different.push(transaction + ': no C# file ' + expectedFile);
    continue;
  }

  const expected = normalize(readFileSync(expectedFile, 'utf8')).split('\r\n');
  const actual = normalize(result.code).split('\r\n');
  const line = expected.findIndex((text, index) => text !== actual[index]);

  if (line < 0 && expected.length === actual.length) {
    equal++;
  } else {
    const at = line < 0 ? Math.min(expected.length, actual.length) : line;
    different.push(transaction + ' (line ' + (at + 1) + ')\n    C#: ' + (expected[at] ?? '<end>') + '\n    JS: ' + (actual[at] ?? '<end>'));
  }
}

console.log(transactions.length + ' transactions, ' + equal + ' equal, ' + different.length + ' different');
different.slice(0, 15).forEach((text) => console.log(text));
process.exit(different.length === 0 ? 0 : 1);
