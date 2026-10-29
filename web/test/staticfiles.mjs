// Checks that web files and shared properties come into the X-Ray: writes a small export folder (a transaction of the
// corpus whose XSL transformation names a stylesheet, the stylesheet, SharedProperties.mem) and X-Rays it; then
// compile it with corpus.mjs.
//   node web/test/staticfiles.mjs <export folder> <work folder>
//   node web/test/corpus.mjs <work folder>/fixture <work folder>/compiled
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FolderSource } from './folder-source.js';
import { DependencyResolver } from '../src/resolver.js';
import { generateCode } from '../src/codefile.js';
import { loadStaticContent, webFilePath } from '../src/staticfiles.js';

const [exportFolder, workFolder] = process.argv.slice(2).map((path) => resolve(path));

if (!exportFolder || !workFolder) {
  console.error('usage: node web/test/staticfiles.mjs <export folder> <work folder>');
  process.exit(2);
}

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

const marker = 'xsi:type="XSLTransform"><Input><ReferenceDocumentSource/></Input><Transform/>';
let template = null;

(function walk(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const full = join(folder, entry.name);

    if (entry.isDirectory()) {
      walk(full);
    } else if (template === null && entry.name.endsWith('.trx') && readFileSync(full, 'utf8').includes(marker)) {
      template = full;
    }
  }
})(exportFolder);

if (template === null) {
  console.log('FAIL no transaction with an XSL transformation in ' + exportFolder);
  process.exit(1);
}

// the stylesheet named by the configured value and by a literal link; an Inline property read by a link
const trx = readFileSync(template, 'utf8')
  .replace(marker, marker.replace('<Transform/>', '<Transform>/XMII/CM/T/xsl/Group.xsl</Transform>'))
  .replace(/(<To>\w+\.Transform<\/To><From>)""(<\/From>)/g, '$1&quot;db://T/WEB/xsl/Group.xsl&quot;$2')
  .replace(/<Assign xsi:type="\w+"><Name\/><Description\/><To>\w+\.InputXSL<\/To><From>[^<]*<\/From><\/Assign>/g, '')
  .replace('<IncomingLinks>', '<IncomingLinks><Assign xsi:type="Assign"><Name/><Description/><To>Local.FixtureSetting</To><From>Inline.FixtureSettings{"Mode"}</From></Assign>');
const stylesheet = '<?xml version="1.0" encoding="UTF-8"?>\n<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"/>\n';
const shared = '<?xml version="1.0" encoding="UTF-8"?><GlobalProperties><Property Cache="N" Description="first line&#10;second line" Name="FixtureSettings" Project="T" StorageType="0" Type="131072"><DefaultValue>{Mode=[string:fast]}</DefaultValue></Property></GlobalProperties>';
const fixture = join(workFolder, 'fixture');
rmSync(fixture, { recursive: true, force: true });

for (const [path, text] of [['T/OBJ/trxXsl.trx', trx], ['T/WEB/xsl/Group.xsl', stylesheet], ['T/META-INF/SharedProperties.mem', shared]]) {
  mkdirSync(dirname(join(fixture, path)), { recursive: true });
  writeFileSync(join(fixture, path), text);
}

const files = ['T/OBJ/trxXsl.trx', 'T/WEB/xsl/Group.xsl', 'T/META-INF/SharedProperties.mem'];
const source = new FolderSource('fixture', files.map((path) => ({ path, read: async () => readFileSync(join(fixture, path), 'utf8') })));
const graph = await new DependencyResolver(source).resolve('T/OBJ/trxXsl');
await loadStaticContent(graph, source, () => {});
const runtime = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/Generate/RuntimeSource.txt'), 'utf8').replace(/^﻿/, '');
const code = generateCode(graph, 'fixture', runtime, new Date()).code;
writeFileSync(join(workFolder, 'trxXsl.xray.cs'), code);

check(graph.files.get('T/WEB/xsl/Group.xsl') === stylesheet, 'stylesheet loaded');
check(code.includes('//   T/WEB/xsl/Group.xsl = MiiFiles.Group_xsl'), 'web file in the header');
check(code.includes('public const string Group_xsl = '), 'web file as constant');
check(/Mii\.XslTransform\([^;]*MiiFiles\.Group_xsl\)/.test(code), 'stylesheet used from the constant');
check(code.includes('//   Inline.FixtureSettings (project T): Cache = N, Description = first line second line, StorageType = 0, Type = 131072'), 'shared property in the header');
check(code.substring(0, code.indexOf('#nullable')).split(/\r?\n/).every((line) => line === '' || line.startsWith('//')), 'every header line is a comment (line breaks in MII texts)');
check(code.includes('//     default: {Mode=[string:fast]}'), 'shared property default');
console.log(failures === 0 ? 'OK (' + relative(process.cwd(), join(workFolder, 'trxXsl.xray.cs')) + ')' : failures + ' failure(s)');
process.exit(failures === 0 ? 0 : 1);
