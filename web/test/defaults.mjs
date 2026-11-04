// Checks the MII defaults in the default mode: X-Rays a small folder whose transactions have defaults of every type,
// compiles it with a harness that calls the methods without arguments (and a caller that links one input) and checks
// the values; a default larger than 128 KB stands as [n-bytes].
//   node web/test/defaults.mjs <work folder>
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { FolderSource } from './folder-source.js';
import { DependencyResolver } from '../src/resolver.js';
import { generateCode } from '../src/codefile.js';
import { loadStaticContent } from '../src/staticfiles.js';

const workFolder = process.argv[2] ? resolve(process.argv[2]) : null;

if (!workFolder) {
  console.error('usage: node web/test/defaults.mjs <work folder>');
  process.exit(2);
}

const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function property(name, type, value, output) {
  return '<ContextItem><Name>' + name + '</Name><Description/><Value xsi:type="' + type + '">' + escape(value) + '</Value><ReadOnly>' + (output ? 'true' : 'false') + '</ReadOnly></ContextItem>';
}

function links(list) {
  return list.map(([to, from]) => '<Assign xsi:type="Assign"><Name/><Description/><To>' + escape(to) + '</To><From>' + escape(from) + '</From></Assign>').join('');
}

function step(name, action) {
  return '<Step xsi:type="ActionSequence"><Name>' + name + '</Name><Description/><Steps/><Actions><Action><Name>' + action.name + '</Name><IncomingLinks>'
    + links(action.incoming || []) + '</IncomingLinks><OutgoingLinks>' + links(action.outgoing || []) + '</OutgoingLinks></Action></Actions></Step>';
}

function trx({ inputs = [], outputs = [], locals = [], actions = [], steps = [] }) {
  return '<?xml version="1.0" encoding="UTF-8"?><Transaction xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + '<TransactionAttributes>' + property('ThrowOnLinkError', 'boolean', '1', true) + property('ThrowOnActionError', 'boolean', '1', true) + '</TransactionAttributes>'
    + '<Context>' + inputs.map(([name, type, value]) => property(name, type, value, false)).join('') + outputs.map(([name, type, value]) => property(name, type, value, true)).join('') + '</Context>'
    + '<Local>' + locals.map(([name, type, value]) => property(name, type, value, false)).join('') + '</Local>'
    + '<Actions>' + actions.map(([name, type, settings]) => '<ContextItem><Name>' + name + '</Name><Description/><Value xsi:type="' + type + '">'
      + Object.entries(settings || {}).map(([key, value]) => '<' + key + '>' + escape(value) + '</' + key + '>').join('') + '</Value></ContextItem>').join('') + '</Actions>'
    + '<Steps>' + steps.join('') + '</Steps></Transaction>';
}

const big = 'x'.repeat(140000);
const bigXml = '<R>' + 'y'.repeat(140000) + '</R>';

const objects = {
  'DEF/trxDefaults.trx': trx({
    inputs: [
      ['Site', 'string', 'M'], ['Flag', 'boolean', 'true'], ['Count', 'integer', '7'], ['Rate', 'double', '1.5'],
      ['Doc', 'xml', '<Rowsets><Rowset><Row><A>row1</A></Row></Rowset></Rowsets>'], ['Plain', 'xml', '<Root><B>b1</B></Root>'],
      ['Names', 'list', '[[string:a], [string:b]]'], ['When', 'dateTime', '2021-03-26T14:23:00'],
      ['Big', 'string', big], ['BigXml', 'xml', bigXml],
    ],
    outputs: [
      ['OutSite', 'string', ''], ['OutFlag', 'string', ''], ['OutCount', 'string', ''], ['OutRate', 'string', ''], ['OutDoc', 'string', ''],
      ['OutPlain', 'string', ''], ['OutNames', 'string', ''], ['OutWhen', 'dateTime', ''], ['OutBigLength', 'string', ''],
      ['OutDefault', 'string', 'kept'], ['OutLocal', 'string', ''],
    ],
    locals: [['L', 'string', 'Ldef'], ['X', 'xml', '<A><B>1</B></A>'], ['Replaced', 'string', 'never read']],
    actions: [['Read', 'Assignment', {}]],
    steps: [step('Sequence_1', {
      name: 'Read',
      outgoing: [
        ['Local.Replaced', '"new"'],
        ['Transaction.OutSite', 'Transaction.Site'], ['Transaction.OutFlag', 'stringif(Transaction.Flag, "yes", "no")'],
        ['Transaction.OutCount', 'Transaction.Count'], ['Transaction.OutRate', 'Transaction.Rate'],
        ['Transaction.OutDoc', 'Transaction.Doc{/Rowsets/Rowset/Row/A}'], ['Transaction.OutPlain', 'Transaction.Plain{/Root/B}'],
        ['Transaction.OutNames', 'listtostring(Transaction.Names, ",")'], ['Transaction.OutWhen', 'Transaction.When'],
        ['Transaction.OutBigLength', 'stringlength(Transaction.Big)'], ['Transaction.OutLocal', 'Local.L & Local.X{/A/B} & Local.Replaced'],
      ],
    })],
  }),
  'DEF/trxCaller.trx': trx({
    outputs: [['Site', 'string', ''], ['Count', 'string', ''], ['Doc', 'string', '']],
    actions: [['Call', 'TransactionCall', { TransactionName: 'DEF/trxDefaults', ResetState: 'false', Async: 'false', Persist: 'NEVER' }], ['Copy', 'Assignment', {}]],
    steps: [
      step('Sequence_1', { name: 'Call', incoming: [['Call.Site', '"L"']] }),
      step('Sequence_2', { name: 'Copy', outgoing: [['Transaction.Site', 'Call.OutSite'], ['Transaction.Count', 'Call.OutCount'], ['Transaction.Doc', 'Call.OutDoc']] }),
    ],
  }),
};

rmSync(workFolder, { recursive: true, force: true });
const exportFolder = join(workFolder, 'export');

for (const [path, text] of Object.entries(objects)) {
  mkdirSync(dirname(join(exportFolder, path)), { recursive: true });
  writeFileSync(join(exportFolder, path), text);
}

const files = Object.keys(objects);
const source = new FolderSource('fixture', files.map((path) => ({ path, read: async () => readFileSync(join(exportFolder, path), 'utf8') })));
const graph = await new DependencyResolver(source).resolveFolder('DEF', await source.folderObjects('DEF'));
await loadStaticContent(graph, source, () => {});
const runtime = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/Generate/RuntimeSource.txt'), 'utf8').replace(/^\uFEFF/, '');
const codeFile = join(workFolder, 'DEF.xray.cs');
const code = generateCode(graph, 'fixture', runtime, new Date()).code;
writeFileSync(codeFile, '\uFEFF' + code);
const namespace = /^namespace ([\w.]+);/m.exec(code)[1];
const logic = /public sealed class (\w+)\(IQueryService /.exec(code)[1];

const harness = `
using System;
using System.Reflection;

namespace ${namespace};

public static class Harness
{
    public static void Main()
    {
        ${logic} logic = new ${logic}(null, null);

        foreach (string name in new[] { "TrxDefaults", "TrxCaller" })
        {
            MethodInfo method = typeof(${logic}).GetMethod(name);
            object[] arguments = new object[method.GetParameters().Length];
            Array.Fill(arguments, Type.Missing);
            object result = method.Invoke(logic, BindingFlags.OptionalParamBinding, null, arguments, null);

            foreach (PropertyInfo property in result.GetType().GetProperties())
            {
                Console.WriteLine(name + " " + property.Name + "=" + property.GetValue(result));
            }
        }
    }
}
`;
writeFileSync(join(workFolder, 'Harness.cs'), harness);

const dotnetRoot = join(process.env.ProgramFiles || 'C:/Program Files', 'dotnet');
const newest = (folder, filter) => readdirSync(folder).filter(filter).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).pop();
const sdk = newest(join(dotnetRoot, 'sdk'), (name) => existsSync(join(dotnetRoot, 'sdk', name, 'Roslyn', 'bincore', 'csc.dll')));
const pack = newest(join(dotnetRoot, 'packs', 'Microsoft.NETCore.App.Ref'), (name) => name.startsWith('8.'));
const runtimeVersion = newest(join(dotnetRoot, 'shared', 'Microsoft.NETCore.App'), (name) => name.startsWith('8.'));
const refs = join(dotnetRoot, 'packs', 'Microsoft.NETCore.App.Ref', pack, 'ref', 'net8.0');
const rsp = join(workFolder, 'references.rsp');
writeFileSync(rsp, readdirSync(refs).filter((name) => name.endsWith('.dll')).map((name) => '-r:"' + join(refs, name) + '"').join('\n'));
const exe = join(workFolder, 'defaults.dll');

try {
  execFileSync(join(dotnetRoot, 'dotnet.exe'), [join(dotnetRoot, 'sdk', sdk, 'Roslyn', 'bincore', 'csc.dll'), '-nologo', '-langversion:12', '-nostdlib', '-warn:0',
    '-target:exe', '-out:' + exe, '@' + rsp, codeFile, join(workFolder, 'Harness.cs')], { stdio: 'pipe' });
} catch (error) {
  console.log('FAIL compile\n' + String(error.stdout || '').split(/\r?\n/).filter((line) => line.includes('error')).slice(0, 20).join('\n'));
  process.exit(1);
}

writeFileSync(join(workFolder, 'defaults.runtimeconfig.json'), JSON.stringify({ runtimeOptions: { tfm: 'net8.0', framework: { name: 'Microsoft.NETCore.App', version: runtimeVersion } } }));
const lines = execFileSync(join(dotnetRoot, 'dotnet.exe'), [exe], { encoding: 'utf8' }).replace(/\r\n/g, '\n').split('\n');
writeFileSync(join(workFolder, 'output.txt'), lines.join('\n'));

let failures = 0;
const check = (ok, message) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + message);
  failures += ok ? 0 : 1;
};
const has = (line, message) => check(lines.includes(line), message + (lines.includes(line) ? '' : ' (expected line: ' + line + ')'));

has('TrxDefaults OutSite=M', 'a text input not passed has its MII default');
has('TrxDefaults OutFlag=yes', 'a boolean input default');
has('TrxDefaults OutCount=7', 'an integer input default');
has('TrxDefaults OutRate=1.5', 'a double input default');
has('TrxDefaults OutDoc=row1', 'a rowset XML input default (typed rows)');
has('TrxDefaults OutPlain=b1', 'an XML input default');
has('TrxDefaults OutNames=a,b', 'a list input default');
check(lines.some((line) => /^TrxDefaults OutWhen=.*2021.*14:23/.test(line)), 'a dateTime input default');
has('TrxDefaults OutDefault=kept', 'an output the flow does not set returns its default');
has('TrxDefaults OutLocal=Ldef1new', 'locals start with their defaults');
has('TrxDefaults OutBigLength=14', 'a text default larger than 128 KB is the text [140000-bytes]');
has('TrxCaller Site=L', 'a linked input wins over the default');
has('TrxCaller Count=7', 'an input the caller does not link gets the callee default');
has('TrxCaller Doc=row1', 'an XML input the caller does not link gets the callee default');
check(code.includes('string site = "M",') && code.includes('bool flag = true,') && code.includes('int count = 7,'), 'constant defaults are parameter defaults');
check(code.includes('string big = "[140000-bytes]",') && !code.includes(big), 'the large text default is left out');
check(/default: \[140007-bytes\]/.test(code) && !code.includes('y'.repeat(100)), 'the large XML default is left out, the comment gives its size');
check(/\/\/ Local\.Replaced \(string\), default: never read/.test(code), 'a local declared where it is set keeps its default in the comment');
check(!/Transaction\.Site \(string\), default/.test(code), 'a default the code holds is not repeated in the comment');

console.log(failures === 0 ? 'OK (' + codeFile + ')' : failures + ' FAILED (' + codeFile + ')');
process.exit(failures === 0 ? 0 : 1);
