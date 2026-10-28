// Checks the raw ZIP: X-Rays folders of an export folder, writes <Folder>.xray.zip, unpacks it with the system's tar
// and compares every entry with the file the source returned.
//   node web/test/rawzip.mjs <export folder> <work folder> <folder> [<folder> ...]
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { FolderSource } from './folder-source.js';
import { DependencyResolver } from '../src/resolver.js';
import { collectRawFiles, buildZip, webFilePath } from '../src/rawexport.js';

const [exportFolder, workFolder, ...folders] = process.argv.slice(2);

if (!exportFolder || !workFolder || folders.length === 0) {
  console.error('usage: node web/test/rawzip.mjs <export folder> <work folder> <folder> [<folder> ...]');
  process.exit(2);
}

const root = resolve(exportFolder);
const files = [];

(function walk(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const full = join(folder, entry.name);

    if (entry.isDirectory()) {
      walk(full);
    } else {
      files.push(relative(root, full).replace(/\\/g, '/'));
    }
  }
})(root);

let failures = 0;
const check = (condition, message) => {
  if (!condition) {
    failures++;
    console.log('FAIL ' + message);
  }
};

check(webFilePath('db://P/WEB/a/b.xsl') === 'P/WEB/a/b.xsl', 'db:// path');
check(webFilePath('/XMII/CM/P/a/b.xsl?x=1') === 'P/WEB/a/b.xsl', '/XMII/CM path');
check(webFilePath('https://host:50000/XMII/CM/P/b.xsd') === 'P/WEB/b.xsd', 'http path');
check(webFilePath('/XMII/Illuminator?QueryTemplate=x') === null, 'servlet URL');
check(webFilePath('db://ME_EI/WEB/EventEngine/') === null, 'folder');

for (const folder of folders) {
  const source = new FolderSource(root, files.map((path) => ({ path, read: async () => readFileSync(join(root, path), 'utf8') })));
  const resolver = new DependencyResolver(source);
  const graph = await resolver.resolveFolder(folder, await source.folderObjects(folder));
  const entries = await collectRawFiles(graph, source, () => {});
  const name = folder.replace(/[\\/]/g, '_');
  const zip = join(resolve(workFolder), name + '.xray.zip');
  const unpacked = join(resolve(workFolder), name);
  rmSync(unpacked, { recursive: true, force: true });
  mkdirSync(unpacked, { recursive: true });
  writeFileSync(zip, buildZip(entries, new Date()));
  execFileSync(process.platform === 'win32' ? join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'tar', ['-xf', zip, '-C', unpacked]);

  for (const entry of entries) {
    const text = readFileSync(join(unpacked, entry.path), 'utf8');
    check(text === entry.text, folder + ': ' + entry.path + ' differs after unpacking');
  }

  for (const object of graph.rawObjects) {
    const loaded = await source.load(object.path);
    check(loaded && loaded.text === object.text, folder + ': ' + object.path + ' is not the loaded text');
  }

  const web = entries.filter((entry) => entry.path.includes('/WEB/')).length;
  const meta = entries.filter((entry) => entry.path.includes('/META-INF/')).length;
  console.log(folder + ': ' + entries.length + ' entries (' + graph.rawObjects.length + ' objects, ' + web + ' web files, ' + meta + ' Meta-Inf)');
}

// a transaction whose XSL transformation names a stylesheet: the stylesheet comes along under T/WEB
const withXsl = files.find((path) => path.endsWith('.trx') && readFileSync(join(root, path), 'utf8').includes('xsi:type="XSLTransform"><Input><ReferenceDocumentSource/></Input><Transform/>'));

if (withXsl) {
  const trx = readFileSync(join(root, withXsl), 'utf8').replace('xsi:type="XSLTransform"><Input><ReferenceDocumentSource/></Input><Transform/>',
    'xsi:type="XSLTransform"><Input><ReferenceDocumentSource/></Input><Transform>/XMII/CM/T/xsl/Group.xsl</Transform>')
    .replace(/(<To>\w+\.Transform<\/To><From>)""(<\/From>)/g, '$1&quot;db://T/WEB/xsl/Group.xsl&quot;$2');
  const stylesheet = '<?xml version="1.0" encoding="UTF-8"?>\n<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"/>\n';
  const fixture = [
    { path: 'T/OBJ/trxXsl.trx', read: async () => trx },
    { path: 'T/WEB/xsl/Group.xsl', read: async () => stylesheet },
    { path: 'T/META-INF/SharedProperties.mem', read: async () => '<GlobalProperties/>' },
  ];
  const source = new FolderSource('fixture', fixture);
  const graph = await new DependencyResolver(source).resolveFolder('T/OBJ', await source.folderObjects('T/OBJ'));
  const entries = await collectRawFiles(graph, source, () => {});
  const byPath = new Map(entries.map((entry) => [entry.path, entry.text]));
  check(byPath.get('T/OBJ/trxXsl.trx') === trx, 'fixture: transaction');
  check(byPath.get('T/WEB/xsl/Group.xsl') === stylesheet, 'fixture: stylesheet');
  check(byPath.get('T/META-INF/SharedProperties.mem') === '<GlobalProperties/>', 'fixture: shared properties');
  console.log('fixture: ' + [...byPath.keys()].join(', '));
} else {
  check(false, 'no transaction with an XSL transformation in the export folder');
}

console.log(failures === 0 ? 'OK' : failures + ' failure(s)');
process.exit(failures === 0 ? 0 : 1);
