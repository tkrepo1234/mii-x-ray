// Proves that the minified page generates the same code: minifies every module of web/src into a copy, X-Rays every
// transaction and folder of an export folder with the copy and with the sources and compares the files (the line with
// the generation time left out). Also checks the bundled script of web/dist/mii-x-ray.html for syntax errors.
//   node web/test/minified.mjs <export folder> <work folder>
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, cpSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { minifyJs } from '../minify.mjs';

const [exportFolder, workFolder] = process.argv.slice(2).map((path) => resolve(path));

if (!exportFolder || !workFolder) {
  console.error('usage: node web/test/minified.mjs <export folder> <work folder>');
  process.exit(2);
}

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const copy = join(workFolder, 'copy');
rmSync(workFolder, { recursive: true, force: true });
mkdirSync(join(copy, 'web', 'src'), { recursive: true });
cpSync(join(web, 'test'), join(copy, 'web', 'test'), { recursive: true });
cpSync(join(web, '..', 'src', 'Generate'), join(copy, 'src', 'Generate'), { recursive: true });

for (const name of readdirSync(join(web, 'src'))) {
  const text = readFileSync(join(web, 'src', name), 'utf8');
  // the names a module exports or imports stay (the page bundles the modules, there they are object keys)
  const keep = [...text.matchAll(/^export (?:async function|function|class|const|let) (\w+)/gm)].map((match) => match[1])
    .concat([...text.matchAll(/^import \{([^}]+)\}/gm)].flatMap((match) => match[1].split(',').map((item) => item.trim())));
  writeFileSync(join(copy, 'web', 'src', name), name.endsWith('.js') ? minifyJs(text, { rename: true, keep }) : text);
}

const node = process.execPath;
const run = (corpus, output) => execFileSync(node, [corpus, exportFolder, output, '--no-compile'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
console.log('sources:  ' + run(join(web, 'test', 'corpus.mjs'), join(workFolder, 'sources')).trim());
console.log('minified: ' + run(join(copy, 'web', 'test', 'corpus.mjs'), join(workFolder, 'minified')).trim());

const withoutTime = (text) => text.replace(/^\/\/ Generated \d{4}-\d{2}-\d{2} \d{2}:\d{2} /m, '// Generated ');
const files = readdirSync(join(workFolder, 'sources')).filter((name) => name.endsWith('.cs'));
const different = files.filter((name) => {
  const other = join(workFolder, 'minified', name);

  try {
    return withoutTime(readFileSync(join(workFolder, 'sources', name), 'utf8')) !== withoutTime(readFileSync(other, 'utf8'));
  } catch {
    return true;
  }
});

const page = readFileSync(join(web, 'dist', 'mii-x-ray.html'), 'utf8');
const script = page.slice(page.indexOf('<script>') + '<script>'.length, page.lastIndexOf('</script>'));
let syntax = 'ok';

try {
  new Function(script);
} catch (error) {
  syntax = error.message;
}

console.log(files.length + ' files compared, ' + different.length + ' different; page script syntax: ' + syntax);
different.slice(0, 10).forEach((name) => console.log('  ' + name));
process.exit(different.length === 0 && files.length > 0 && syntax === 'ok' ? 0 : 1);
