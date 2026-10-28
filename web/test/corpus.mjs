// The regression check of the leading (JavaScript) generator: X-Rays every transaction and every folder of an export
// folder and compiles each generated file on its own as C# 12 against the .NET 8 reference assemblies.
//   node web/test/corpus.mjs <export folder> <work folder> [--no-compile]
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ObjectPath } from '../src/sources.js';
import { FolderSource } from './folder-source.js';
import { DependencyResolver } from '../src/resolver.js';
import { generateCode } from '../src/codefile.js';

const args = process.argv.slice(2);
const compile = !args.includes('--no-compile');
const [exportFolder, workFolder] = args.filter((arg) => !arg.startsWith('--')).map((path) => resolve(path));

if (!exportFolder || !workFolder) {
  console.error('usage: node web/test/corpus.mjs <export folder> <work folder> [--no-compile]');
  process.exit(2);
}

const runtime = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/Generate/RuntimeSource.txt'), 'utf8').replace(/^\uFEFF/, '');
const files = [];

(function walk(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const full = join(folder, entry.name);

    if (entry.isDirectory()) {
      walk(full);
    } else {
      files.push(relative(exportFolder, full).replace(/\\/g, '/'));
    }
  }
})(exportFolder);

const source = new FolderSource(exportFolder, files.map((path) => ({ path, read: async () => readFileSync(join(exportFolder, path), 'utf8') })));
const objects = files.filter((path) => ObjectPath.isKnownExtension(path));
const folders = [...new Set(objects.flatMap((path) => {
  const parts = ObjectPath.normalize(path).split('/');
  return parts.slice(1, -1).map((unused, index) => parts.slice(0, index + 2).join('/'));
}))].sort();

rmSync(workFolder, { recursive: true, force: true });
mkdirSync(workFolder, { recursive: true });
const generated = [];
const problems = [];
let index = 0;

async function run(kind, path, resolveGraph) {
  const graph = await resolveGraph(new DependencyResolver(source));

  if (!graph) {
    problems.push(kind + ' ' + path + ': not resolved');
    return;
  }

  const result = generateCode(graph, 'export folder ' + exportFolder, runtime, new Date());
  const file = join(workFolder, kind + '-' + String(++index).padStart(4, '0') + '-' + result.rootName + '.xray.cs');
  writeFileSync(file, '\uFEFF' + result.code);
  generated.push({ kind, path, file });
}

for (const path of objects.filter((item) => item.toLowerCase().endsWith('.trx')).sort()) {
  await run('trx', path, (resolver) => resolver.resolve(path));
}

for (const folder of folders) {
  await run('folder', folder, async (resolver) => resolver.resolveFolder(folder, await source.folderObjects(folder)));
}

console.log(generated.filter((item) => item.kind === 'trx').length + ' transactions and ' + generated.filter((item) => item.kind === 'folder').length + ' folders X-rayed, ' + problems.length + ' not resolved');
problems.slice(0, 10).forEach((problem) => console.log('  ' + problem));

if (!compile) {
  process.exit(problems.length === 0 ? 0 : 1);
}

const dotnetRoot = join(process.env.ProgramFiles || 'C:/Program Files', 'dotnet');
const newest = (folder, filter) => readdirSync(folder).filter(filter).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).pop();
const sdk = newest(join(dotnetRoot, 'sdk'), (name) => existsSync(join(dotnetRoot, 'sdk', name, 'Roslyn', 'bincore', 'csc.dll')));
const pack = newest(join(dotnetRoot, 'packs', 'Microsoft.NETCore.App.Ref'), (name) => name.startsWith('8.'));
const csc = join(dotnetRoot, 'sdk', sdk, 'Roslyn', 'bincore', 'csc.dll');
const refs = join(dotnetRoot, 'packs', 'Microsoft.NETCore.App.Ref', pack, 'ref', 'net8.0');
const rsp = join(workFolder, 'references.rsp');
writeFileSync(rsp, readdirSync(refs).filter((name) => name.endsWith('.dll')).map((name) => '-r:"' + join(refs, name) + '"').join('\n'));
const failed = [];

for (const item of generated) {
  try {
    execFileSync(join(dotnetRoot, 'dotnet.exe'), [csc, '-nologo', '-shared', '-langversion:12', '-nostdlib', '-warn:0', '-target:library',
      '-out:' + item.file.replace(/\.cs$/, '.dll'), '@' + rsp, item.file], { stdio: 'pipe' });
  } catch (error) {
    const errors = String(error.stdout || '').split(/\r?\n/).filter((line) => line.includes('error')).slice(0, 3);
    failed.push(item.kind + ' ' + item.path + '\n    ' + errors.join('\n    '));
  }
}

console.log(generated.length + ' generated, ' + (generated.length - failed.length) + ' compiled, ' + failed.length + ' failed');
failed.slice(0, 20).forEach((text) => console.log(text));
process.exit(failed.length === 0 && problems.length === 0 ? 0 : 1);
