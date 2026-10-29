// Proves the simulation mode on .NET: writes small transactions and query templates (folder SIM), X-Rays the folder,
// converts the file into the simulation mode, compiles it with a harness (fake query and plugin services that print
// what they get) and checks each MII property the mode emulates.
//   node web/test/simrun.mjs <work folder>
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { FolderSource } from './folder-source.js';
import { DependencyResolver } from '../src/resolver.js';
import { generateCode } from '../src/codefile.js';
import { loadStaticContent } from '../src/staticfiles.js';
import { convertToSimulation } from './simulation.mjs';

const workFolder = process.argv[2] ? resolve(process.argv[2]) : null;

if (!workFolder) {
  console.error('usage: node web/test/simrun.mjs <work folder>');
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------- the fixture

const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function property(name, type, value, output) {
  return '<ContextItem><Name>' + name + '</Name><Description/><Value xsi:type="' + type + '">' + escape(value) + '</Value><ReadOnly>' + (output ? 'true' : 'false') + '</ReadOnly></ContextItem>';
}

function links(list) {
  return list.map(([to, from, kind = 'Assign']) => '<Assign xsi:type="' + kind + '"><Name/><Description/><To>' + escape(to) + '</To><From>' + escape(from) + '</From></Assign>').join('');
}

function step(type, name, action, children = []) {
  const actionXml = action
    ? '<Actions><Action><Name>' + action.name + '</Name><IncomingLinks>' + links(action.incoming || []) + '</IncomingLinks><OutgoingLinks>' + links(action.outgoing || []) + '</OutgoingLinks></Action></Actions>'
    : '<Actions/>';
  return '<Step xsi:type="' + type + '"><Name>' + name + '</Name><Description/><Steps>' + children.join('') + '</Steps>' + actionXml + '</Step>';
}

/** A transaction: attributes, inputs/outputs/locals as [name, type, default], actions as [name, type, {property: value}]. */
function trx({ throwOnLinkError = '1', throwOnActionError = '1', inputs = [], outputs = [], locals = [], actions = [], steps = [] }) {
  const attributes = [['ThrowOnLinkError', 'boolean', throwOnLinkError], ['ThrowOnActionError', 'boolean', throwOnActionError]];
  return '<?xml version="1.0" encoding="UTF-8"?><Transaction xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + '<TransactionAttributes>' + attributes.map(([name, type, value]) => property(name, type, value, true)).join('') + '</TransactionAttributes>'
    + '<Context>' + inputs.map(([name, type, value]) => property(name, type, value, false)).join('') + outputs.map(([name, type, value]) => property(name, type, value, true)).join('') + '</Context>'
    + '<Local>' + locals.map(([name, type, value]) => property(name, type, value, false)).join('') + '</Local>'
    + '<Actions>' + actions.map(([name, type, settings]) => '<ContextItem><Name>' + name + '</Name><Description/><Value xsi:type="' + type + '">'
      + Object.entries(settings || {}).map(([key, value]) => '<' + key + '>' + escape(value) + '</' + key + '>').join('') + '</Value></ContextItem>').join('') + '</Actions>'
    + '<Steps>' + steps.join('') + '</Steps></Transaction>';
}

function sql(text, attributes) {
  return '<?xml version="1.0" encoding="UTF-8"?><SQLQuery Mode="FixedQuery" Query="' + escape(text) + '" '
    + Object.entries(attributes).map(([key, value]) => key + '="' + escape(value) + '"').join(' ') + '/>';
}

const call = (resetState) => ({ TransactionName: 'SIM/trxCallee', ResetState: resetState, Async: 'false', Persist: 'NEVER', In1: 'stale snapshot' });

function caller(resetState) {
  return trx({
    outputs: [['Count', 'integer', '0'], ['Out', 'string', ''], ['EchoIn', 'string', ''], ['EchoNum', 'double', '0']],
    actions: [['Twice', 'ForNextRepeaterAction', { From: '1', To: '2', Step: '1' }], ['CallCallee', 'TransactionCall', call(resetState)], ['Collect', 'Assignment', {}]],
    steps: [
      step('ForNextRepeater', 'Sequence_1', { name: 'Twice' }, [step('ActionSequence', 'Sequence_2', { name: 'CallCallee', incoming: [['CallCallee.Num', '7']] })]),
      step('ActionSequence', 'Sequence_3', {
        name: 'Collect',
        outgoing: [['Transaction.Count', 'CallCallee.Count'], ['Transaction.Out', 'CallCallee.Out1'], ['Transaction.EchoIn', 'CallCallee.EchoIn'], ['Transaction.EchoNum', 'CallCallee.EchoNum']],
      }),
    ],
  });
}

function linkError(throwOnLinkError) {
  return trx({
    throwOnLinkError,
    inputs: [['Text', 'string', 'abc']],
    outputs: [['Res', 'string', 'start'], ['Num', 'integer', '42']],
    actions: [['Assign', 'Assignment', {}]],
    steps: [step('ActionSequence', 'Sequence_1', {
      name: 'Assign',
      outgoing: [['Transaction.Res', '"a"'], ['Transaction.Num', 'Transaction.Text'], ['Transaction.Res', 'Transaction.Res & "b"']],
    })],
  });
}

function notRun(throwOnLinkError) {
  return trx({
    throwOnLinkError,
    outputs: [['Res', 'string', 'keep'], ['After', 'string', '']],
    actions: [['Never', 'ConditionalAction', { InputCount: '1', LogicalAnd: 'true', Input1: 'false' }], ['CallNotRun', 'TransactionCall', call('true')], ['Read', 'Assignment', {}]],
    steps: [
      step('Conditional', 'Sequence_1', { name: 'Never', incoming: [['Never.Input1', 'false']] }, [step('ActionSequence', 'Sequence_2', { name: 'CallNotRun' })]),
      step('ActionSequence', 'Sequence_3', { name: 'Read', outgoing: [['Transaction.Res', 'CallNotRun.Out1'], ['Transaction.After', '"done"']] }),
    ],
  });
}

function actionError(throwOnActionError) {
  return trx({
    throwOnActionError,
    outputs: [['Res', 'string', '']],
    actions: [['Fail', 'FailingAction', { Setting: 'x' }], ['After', 'Assignment', {}]],
    steps: [step('ActionSequence', 'Sequence_1', { name: 'Fail' }), step('ActionSequence', 'Sequence_2', { name: 'After', outgoing: [['Transaction.Res', '"after"']] })],
  });
}

const objects = {
  'SIM/trxCallee.trx': trx({
    inputs: [['In1', 'string', 'D1'], ['Num', 'double', '5']],
    outputs: [['Out1', 'string', 'O1'], ['Count', 'integer', '0'], ['EchoIn', 'string', ''], ['EchoNum', 'double', '0']],
    locals: [['L1', 'string', 'L1def']],
    actions: [['Work', 'Assignment', {}]],
    steps: [step('ActionSequence', 'Sequence_1', {
      name: 'Work',
      outgoing: [['Transaction.Count', 'Transaction.Count + 1'], ['Transaction.Out1', 'Local.L1 & "|" & Transaction.Out1'], ['Transaction.EchoIn', 'Transaction.In1'], ['Transaction.EchoNum', 'Transaction.Num']],
    })],
  }),
  'SIM/trxCallerKeep.trx': caller('false'),
  'SIM/trxCallerReset.trx': caller('true'),
  'SIM/trxLinkError0.trx': linkError('0'),
  'SIM/trxLinkError1.trx': linkError('1'),
  'SIM/trxNotRun0.trx': notRun('0'),
  'SIM/trxNotRun1.trx': notRun('1'),
  'SIM/trxActionError0.trx': actionError('0'),
  'SIM/trxActionError1.trx': actionError('1'),
  'SIM/trxQuery.trx': trx({
    outputs: [['A', 'string', ''], ['N', 'string', '']],
    actions: [['Text', 'IlluminatorSQLQueryObject', { QueryTemplate: 'SIM/sqlText' }], ['Typed', 'IlluminatorSQLQueryObject', { QueryTemplate: 'SIM/sqlTyped' }]],
    steps: [
      step('ActionSequence', 'Sequence_1', { name: 'Text', incoming: [['Text.Param.1', '"x"']], outgoing: [['Transaction.A', 'Text.Results{/Rowsets/Rowset/Row/A}'], ['Transaction.N', 'Text.Results{/Rowsets/Rowset/Row/N}']] }),
      step('ActionSequence', 'Sequence_2', { name: 'Typed', incoming: [['Typed.Param.1', '"5"']] }),
    ],
  }),
  'SIM/trxXPath.trx': trx({
    outputs: [['C1', 'string', ''], ['C2', 'string', ''], ['C3', 'string', ''], ['C4', 'string', '']],
    locals: [['Doc', 'xml', '<Rowsets><Rowset><Row><A>1</A></Row><Row><A>2</A></Row></Rowset></Rowsets>']],
    actions: [['Read', 'Assignment', {}]],
    steps: [step('ActionSequence', 'Sequence_1', {
      name: 'Read',
      outgoing: [['Transaction.C1', 'Local.Doc{count(/Rowsets/Rowset/Row/)}'], ['Transaction.C2', 'first(getlistfromxpath(Local.Doc, "count(//Row[A=\'1\'])"))'],
        ['Transaction.C3', 'Local.Doc{sum(//A) div 4}'], ['Transaction.C4', 'Local.Doc{count(//Row[  A = \'1\'\n    or\n  A = \'2\'\n])}']],
    })],
  }),
  'SIM/trxRegex.trx': trx({
    outputs: [['R1', 'string', ''], ['R2', 'boolean', 'false'], ['R3', 'string', ''], ['R4', 'boolean', 'false'], ['I1', 'integer', '9'], ['I2', 'integer', '9'], ['I3', 'integer', '9'], ['A1', 'integer', '0']],
    actions: [['Work', 'Assignment', {}]],
    steps: [step('ActionSequence', 'Sequence_1', {
      name: 'Work',
      outgoing: [['Transaction.R1', 'stringreplaceall("ResourceBO:M,X", ":.*+$", "")'], ['Transaction.R2', 'match("ab", "^\\\\p{Lower}+$")'],
        ['Transaction.R3', 'stringreplaceall("a.b*c", "\\\\Q.b*\\\\E", "-")'], ['Transaction.R4', 'match("a_b", "^[a-z\\\\_]+$")'],
        ['Transaction.I1', 'stringindexof("football", "ball")'], ['Transaction.I2', 'stringindexof("football", "x")'], ['Transaction.I3', 'stringlastindexof("a;b;c", ";")'],
        ['Transaction.A1', 'size(append(list("a"), "b", "c", "d", "e"))']],
    })],
  }),
  'SIM/trxFormats.trx': trx({
    outputs: [['D', 'string', ''], ['DT', 'dateTime', ''], ['F', 'string', ''], ['G', 'string', ''], ['I', 'string', ''], ['F2', 'string', '']],
    actions: [['Date', 'IlluminatorSQLQueryObject', { QueryTemplate: 'SIM/sqlDate' }], ['Number', 'IlluminatorSQLQueryObject', { QueryTemplate: 'SIM/sqlNumber' }],
      ['Number2', 'IlluminatorSQLQueryObject', { QueryTemplate: 'SIM/sqlNumber', XmlNumberFormat: '0.0' }]],
    steps: [
      step('ActionSequence', 'Sequence_1', {
        name: 'Date',
        outgoing: [['Transaction.D', 'dateformat(Date.Results{/Rowsets/Rowset/Row/D}, Date.DateFormat, "yyyy-MM-dd\'T\'HH:mm:ss")'],
          ['Transaction.DT', 'dateformat(Date.Results{/Rowsets/Rowset/Row/D}, Date.DateFormat, "yyyy-MM-dd\'T\'HH:mm:ss")']],
      }),
      step('ActionSequence', 'Sequence_2', {
        name: 'Number',
        outgoing: [['Transaction.F', 'Number.Results{/Rowsets/Rowset/Row/F}'], ['Transaction.G', 'Number.Results{/Rowsets/Rowset/Row/G}'], ['Transaction.I', 'Number.Results{/Rowsets/Rowset/Row/I}']],
      }),
      step('ActionSequence', 'Sequence_3', { name: 'Number2', outgoing: [['Transaction.F2', 'Number2.Results{/Rowsets/Rowset/Row/F}']] }),
    ],
  }),
  'SIM/trxMulti.trx': trx({
    outputs: [['M1', 'string', ''], ['M2', 'string', ''], ['D1', 'string', ''], ['NB', 'boolean', 'false'], ['CT', 'boolean', 'false'], ['RC', 'string', '']],
    actions: [['Multi', 'IlluminatorSQLQueryObject', { QueryTemplate: 'SIM/sqlMulti' }], ['Tools', 'IlluminatorSQLQueryObject', { QueryTemplate: 'SIM/sqlTools' }],
      ['CallRows', 'TransactionCall', { TransactionName: 'SIM/trxRows', ResetState: 'true' }]],
    steps: [
      step('ActionSequence', 'Sequence_1', {
        name: 'Multi',
        outgoing: [['Transaction.M1', 'Multi.Results{count(/Rowsets/Rowset[2]/Row)}'], ['Transaction.M2', 'Multi.Results{/Rowsets/Rowset[2]/Row[2]/B}'],
          ['Transaction.D1', 'Multi.Results{/Rowsets/Rowset[1]/Row[1]/END}'], ['Transaction.NB', 'Multi.Results{/Rowsets/Rowset[1]/Row/END} == "TimeUnavailable"']],
      }),
      step('ActionSequence', 'Sequence_2', {
        name: 'Tools',
        outgoing: [['Transaction.CT', 'first(getlistfromxpath(Tools.Results, "count(/Rowsets/Rowset/Row[TOOL_NUMBER = \'T2\'])")) > 0']],
      }),
      step('ActionSequence', 'Sequence_3', {
        name: 'CallRows',
        incoming: [['CallRows.Rows', '"<Rowsets><Rowset><Row><A>1</A><Z>9</Z></Row></Rowset></Rowsets>"']],
        outgoing: [['Transaction.RC', 'CallRows.Count']],
      }),
    ],
  }),
  'SIM/trxRows.trx': trx({
    inputs: [['Rows', 'xml', '<Rowsets><Rowset><Row><A>a</A></Row></Rowset></Rowsets>']],
    outputs: [['Count', 'string', '']],
    actions: [['Read', 'Assignment', {}]],
    steps: [step('ActionSequence', 'Sequence_1', { name: 'Read', outgoing: [['Transaction.Count', 'Transaction.Rows{count(/Rowsets/Rowset/Row/Z)}']] })],
  }),
  'SIM/trxXml.trx': trx({
    outputs: [['Sum', 'string', ''], ['Appended', 'string', ''], ['DY', 'string', ''], ['Num', 'double', '5']],
    locals: [['Doc', 'xml', '<p:root xmlns:p="urn:p"><p:item><p:v>1</p:v></p:item><p:item><p:v>2</p:v></p:item></p:root>'],
      ['Src', 'xml', '<r><i>1</i><i>2</i></r>'], ['Target', 'xml', '<list/>'], ['Name', 'string', 'ab'], ['NaText', 'string', 'NA']],
    actions: [['Rep', 'RepeaterAction', {}], ['AddItem', 'Assignment', {}], ['Append', 'Assignment', {}], ['Unique', 'Distinct', { ValueSource: 'Local.Src{/r/i}' }],
      ['Dyn', 'Assignment', {}], ['Join', 'Joiner', { ParentSource: 'Local.Src', ChildSource: 'Local.Target' }]],
    steps: [
      step('Repeater', 'Sequence_1', { name: 'Rep', incoming: [['Rep.Source', 'Local.Doc{/p:root/p:item}']] },
        [step('ActionSequence', 'Sequence_2', { name: 'AddItem', outgoing: [['Transaction.Sum', 'Transaction.Sum & Rep.Output{/p:item/p:v}']] })]),
      step('ActionSequence', 'Sequence_3', {
        name: 'Append',
        outgoing: [['Local.Target{/list}', 'Local.Src{/r/i}', 'AppendXml'], ['Transaction.Appended', 'Local.Target{count(/list/i)}']],
      }),
      step('ActionSequence', 'Sequence_4', { name: 'Unique' }),
      step('ActionSequence', 'Sequence_5', { name: 'Dyn', outgoing: [['Transaction.DY', 'stringreplaceall("x-ab-y", "#Local.Name#", "Z")'], ['Transaction.Num', 'Local.NaText']] }),
      step('ActionSequence', 'Sequence_6', { name: 'Join' }),
    ],
  }),
  'SIM/trxXslMissing.trx': trx({
    outputs: [['Out', 'string', '']],
    locals: [['Src', 'xml', '<r/>']],
    actions: [['Tx', 'XSLTransform', { Transform: '', InputXSL: '' }]],
    steps: [step('ActionSequence', 'Sequence_1', { name: 'Tx', incoming: [['Tx.Input', 'Local.Src']], outgoing: [['Transaction.Out', 'Tx.Output']] })],
  }),
  'SIM/sqlMulti.tqsq': sql('do begin select A, END from X; select B from Y; end', { UseTypedParams: 'F' }),
  'SIM/trxStar.trx': trx({
    outputs: [['Txt', 'string', ''], ['Dyn1', 'string', ''], ['Dyn2', 'string', ''], ['Dyn3', 'string', ''], ['Dyn4', 'string', '']],
    locals: [['Letters', 'list', '[[string:a],[string:b]]']],
    actions: [['Star', 'IlluminatorSQLQueryObject', { QueryTemplate: 'SIM/sqlStar' }], ['Rep', 'RepeaterAction', {}], ['Add', 'Assignment', {}],
      ['It', 'IteratorAction', {}], ['Collect', 'Assignment', {}]],
    steps: [
      step('ActionSequence', 'Sequence_1', { name: 'Star' }),
      step('Repeater', 'Sequence_2', { name: 'Rep', incoming: [['Rep.Source', 'Star.Results{/Rowsets/Rowset/Row}']] },
        [step('ActionSequence', 'Sequence_3', {
          name: 'Add',
          outgoing: [['Transaction.Txt', 'Rep.Output'], ['Transaction.Dyn1', '"id:#Rep.Item{/Row/INVENTORY_ID}#"'],
            ['Transaction.Dyn2', '"q:#Star.Results{/Rowsets/Rowset/Row/QTY_ON_HAND}#"']],
        })]),
      step('Iterator', 'Sequence_4', { name: 'It', incoming: [['It.Source', 'Local.Letters']] },
        [step('ActionSequence', 'Sequence_5', { name: 'Collect', outgoing: [['Transaction.Dyn3', 'Transaction.Dyn3 & "#It.CurrentItem#"'], ['Transaction.Dyn4', '"last:#Rep.Item{/Row/INVENTORY_ID}#"']] })]),
    ],
  }),
  'SIM/sqlStar.tqsq': sql('select * from INVENTORY', { UseTypedParams: 'F' }),
  'SIM/sqlTools.tqsq': sql('select TOOL_NUMBER from TOOLS', { UseTypedParams: 'F' }),
  'SIM/sqlDate.tqsq': sql('select D from T', { UseTypedParams: 'F', DateFormat: 'dd.MM.yyyy HH:mm:ss' }),
  'SIM/sqlNumber.tqsq': sql('select F, G, I from T', { UseTypedParams: 'F', NumberFormat: '0.00' }),
  'SIM/sqlText.tqsq': sql("select '[Param.1]' as A, '[Param.2]' as B, '[Param.3]' as C, N from DUMMY", { UseTypedParams: 'F', 'Param.2': 'dflt', 'Param.3': '' }),
  'SIM/sqlTyped.tqsq': sql('select A, N from T where A = [Param.1] and B = [Param.2]', { UseTypedParams: 'T', 'ParamType.1': 'Integer', 'ParamType.2': 'String', 'Param.2': 'z' }),
};

const harness = `
using System;
using System.Collections.Generic;
using System.Linq;

namespace NAMESPACE;

public static class Harness
{
    public static void Main()
    {
        Run("keep", "SIM/trxCallerKeep", []);
        Run("reset", "SIM/trxCallerReset", []);
        Run("callee", "SIM/trxCallee", new Dictionary<string, string> { ["Num"] = "abc" });
        Run("link0", "SIM/trxLinkError0", []);
        Run("link1", "SIM/trxLinkError1", []);
        Run("notrun0", "SIM/trxNotRun0", []);
        Run("notrun1", "SIM/trxNotRun1", []);
        Run("action0", "SIM/trxActionError0", []);
        Run("action1", "SIM/trxActionError1", []);
        Run("query", "SIM/trxQuery", []);
        Run("xpath", "SIM/trxXPath", []);
        Run("regex", "SIM/trxRegex", []);
        Run("formats", "SIM/trxFormats", []);
        Run("multi", "SIM/trxMulti", []);
        Run("xml", "SIM/trxXml", []);
        Run("xsl", "SIM/trxXslMissing", []);
        Run("star", "SIM/trxStar", []);
    }

    private static void Run(string label, string path, Dictionary<string, string> inputs)
    {
        MiiSim simulation = new MiiSim(new Queries(label), new Plugins(label));

        try
        {
            IDictionary<string, string> outputs = MiiSim.Run(new LOGIC(simulation), path, inputs);

            foreach (KeyValuePair<string, string> output in outputs.OrderBy((pair) => pair.Key))
            {
                Console.WriteLine(label + " " + output.Key + "=" + output.Value);
            }
        }
        catch (Exception exception)
        {
            Console.WriteLine(label + " ERROR " + exception.Message);
        }

        foreach (string diagnostic in simulation.Diagnostics)
        {
            Console.WriteLine(label + " DIAG " + diagnostic);
        }
    }

    private sealed class Queries(string label) : IQueryService
    {
        public SimQueryResult Execute(SimQuery query)
        {
            Console.WriteLine(label + " SQL " + query.Sql + " VALUES " + string.Join(",", query.Values.Select((value) => value == null ? "null" : value.GetType().Name + ":" + value)));

            if (query.TemplatePath == "SIM/sqlDate")
            {
                return SimQueryResult.Of([new Dictionary<string, string> { ["D"] = "28.10.2026 10:00:00" }]);
            }

            if (query.TemplatePath == "SIM/sqlNumber")
            {
                Console.WriteLine(label + " NUMBERFORMAT " + query.NumberFormat);
                return SimQueryResult.Of([new Dictionary<string, string> { ["F"] = "2.675", ["G"] = "1.005", ["I"] = "12" }]);
            }

            if (query.TemplatePath == "SIM/sqlMulti")
            {
                // a SQLScript block with two result sets; END is a NULL timestamp
                SimRowset first = new SimRowset { Columns = [new SimColumn { Name = "A", Type = "NVARCHAR" }, new SimColumn { Name = "END", Type = "TIMESTAMP" }] };
                first.Rows.Add(new Dictionary<string, string> { ["A"] = "1", ["END"] = null });
                SimRowset second = new SimRowset { Columns = [new SimColumn { Name = "B", Type = "NVARCHAR" }] };
                second.Rows.Add(new Dictionary<string, string> { ["B"] = "x" });
                second.Rows.Add(new Dictionary<string, string> { ["B"] = "y" });
                return new SimQueryResult { Rowsets = [first, second] };
            }

            if (query.TemplatePath == "SIM/sqlStar")
            {
                return SimQueryResult.Of([new Dictionary<string, string> { ["INVENTORY_ID"] = "I1", ["QTY_ON_HAND"] = "5" }]);
            }

            if (query.TemplatePath == "SIM/sqlTools")
            {
                return SimQueryResult.Of([new Dictionary<string, string> { ["TOOL_NUMBER"] = "T1" }, new Dictionary<string, string> { ["TOOL_NUMBER"] = "T2" }]);
            }

            return SimQueryResult.Of([new Dictionary<string, string> { ["A"] = "r1  ", ["N"] = null }]);
        }
    }

    private sealed class Plugins(string label) : IPluginService
    {
        public PluginResult Invoke(string actionType, string actionName, Dictionary<string, object> settings)
        {
            Console.WriteLine(label + " PLUGIN " + actionType + " " + actionName + " " + string.Join(",", settings.Select((pair) => pair.Key + "=" + Mii.ToStr(pair.Value))));

            if (actionType == "FailingAction")
            {
                throw new InvalidOperationException("plugin failed");
            }

            return new PluginResult();
        }

        public void Log(string level, string message) => Console.WriteLine(label + " LOG " + level + " " + message);

        public string LoadResource(string path) => "";

        public object GetProperty(string name) => "";

        public void SetProperty(string name, object value)
        {
        }

        public IDictionary<string, string> CallExternal(string path, IDictionary<string, string> inputs)
        {
            Console.WriteLine(label + " EXTERNAL " + path);
            return new Dictionary<string, string>();
        }
    }
}
`;

// ---------------------------------------------------------------------------------------------- X-Ray, convert, run

rmSync(workFolder, { recursive: true, force: true });
const exportFolder = join(workFolder, 'export');

for (const [path, text] of Object.entries(objects)) {
  mkdirSync(dirname(join(exportFolder, path)), { recursive: true });
  writeFileSync(join(exportFolder, path), text);
}

const files = Object.keys(objects);
const source = new FolderSource('fixture', files.map((path) => ({ path, read: async () => readFileSync(join(exportFolder, path), 'utf8') })));
const graph = await new DependencyResolver(source).resolveFolder('SIM', await source.folderObjects('SIM'));
await loadStaticContent(graph, source, () => {});
const runtime = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/Generate/RuntimeSource.txt'), 'utf8').replace(/^\uFEFF/, '');
const defaultFile = join(workFolder, 'SIM.xray.cs');
const simulationFile = join(workFolder, 'SIM.sim.cs');
writeFileSync(defaultFile, '\uFEFF' + generateCode(graph, 'fixture', runtime, new Date()).code);
convertToSimulation([[defaultFile, simulationFile]]);
const code = readFileSync(simulationFile, 'utf8');
const namespace = /^namespace ([\w.]+);/m.exec(code)[1];
const logic = /public sealed class (\w+)\(MiiSim /.exec(code)[1];
writeFileSync(join(workFolder, 'Harness.cs'), harness.replace('NAMESPACE', namespace).replace('LOGIC', logic));

const dotnetRoot = join(process.env.ProgramFiles || 'C:/Program Files', 'dotnet');
const newest = (folder, filter) => readdirSync(folder).filter(filter).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).pop();
const sdk = newest(join(dotnetRoot, 'sdk'), (name) => existsSync(join(dotnetRoot, 'sdk', name, 'Roslyn', 'bincore', 'csc.dll')));
const pack = newest(join(dotnetRoot, 'packs', 'Microsoft.NETCore.App.Ref'), (name) => name.startsWith('8.'));
const runtimeVersion = newest(join(dotnetRoot, 'shared', 'Microsoft.NETCore.App'), (name) => name.startsWith('8.'));
const refs = join(dotnetRoot, 'packs', 'Microsoft.NETCore.App.Ref', pack, 'ref', 'net8.0');
const rsp = join(workFolder, 'references.rsp');
writeFileSync(rsp, readdirSync(refs).filter((name) => name.endsWith('.dll')).map((name) => '-r:"' + join(refs, name) + '"').join('\n'));
const exe = join(workFolder, 'simrun.dll');

try {
  execFileSync(join(dotnetRoot, 'dotnet.exe'), [join(dotnetRoot, 'sdk', sdk, 'Roslyn', 'bincore', 'csc.dll'), '-nologo', '-langversion:12', '-nostdlib', '-warn:0',
    '-target:exe', '-out:' + exe, '@' + rsp, simulationFile, join(workFolder, 'Harness.cs')], { stdio: 'pipe' });
} catch (error) {
  console.log('FAIL compile\n' + String(error.stdout || '').split(/\r?\n/).filter((line) => line.includes('error')).slice(0, 20).join('\n'));
  process.exit(1);
}

writeFileSync(join(workFolder, 'simrun.runtimeconfig.json'), JSON.stringify({ runtimeOptions: { tfm: 'net8.0', framework: { name: 'Microsoft.NETCore.App', version: runtimeVersion } } }));
const output = execFileSync(join(dotnetRoot, 'dotnet.exe'), [exe], { encoding: 'utf8' }).replace(/\r\n/g, '\n');
writeFileSync(join(workFolder, 'output.txt'), output);
const lines = output.split('\n');

// ---------------------------------------------------------------------------------------------- the checks

let failures = 0;
const has = (line, message) => {
  if (lines.includes(line)) {
    console.log('ok   ' + message);
  } else {
    failures++;
    console.log('FAIL ' + message + ' (expected line: ' + line + ')');
  }
};
const matches = (pattern, message) => {
  if (lines.some((line) => pattern.test(line))) {
    console.log('ok   ' + message);
  } else {
    failures++;
    console.log('FAIL ' + message + ' (expected a line like ' + pattern + ')');
  }
};

has('keep Count=2', 'ResetState false: the second call sees the outputs of the first (Count 2)');
has('keep Out=L1def|L1def|O1', 'ResetState false: the output keeps its value of the previous call');
has('reset Count=1', 'ResetState true: every call starts from the defaults (Count 1)');
has('reset Out=L1def|O1', 'ResetState true: output and local start with their defaults');
has('keep EchoIn=D1', 'an unlinked input gets the callee default (not the stored snapshot)');
has('keep EchoNum=7', 'a linked input gets the linked value');
has('callee EchoIn=D1', 'Run: an input not given gets its default');
has('callee EchoNum=0', 'Run: a number input given "abc" arrives as 0');
has('link0 Res=ab', 'ThrowOnLinkError 0: the run goes on after the failing link');
has('link0 Num=42', 'ThrowOnLinkError 0: the failing link leaves its target unchanged');
matches(/^link0 DIAG .*Conversion Exception/, 'ThrowOnLinkError 0: the swallowed link error is recorded');
matches(/^link1 ERROR Conversion Exception/, 'ThrowOnLinkError 1: the failing link raises the exception');
has('notrun0 Res=keep', 'a link to an output of an action that did not run fails; ThrowOnLinkError 0 keeps the target');
has('notrun0 After=done', 'ThrowOnLinkError 0: the later link still runs');
matches(/^notrun1 ERROR Invalid variable: CallNotRun/, 'ThrowOnLinkError 1: "Invalid variable" raises the exception');
has('action0 Res=after', 'ThrowOnActionError 0: the run goes on after the failing action');
matches(/^action0 DIAG .*plugin failed/, 'ThrowOnActionError 0: the action error is recorded');
matches(/^action1 ERROR plugin failed/, 'ThrowOnActionError 1: the failing action raises the exception');
has("query SQL select 'x' as A, 'dflt' as B, '' as C, N from DUMMY VALUES ", 'text parameters: set value, template default, unset slot without default is ""');
has('query SQL select A, N from T where A = ? and B = ? VALUES Int64:5,String:z', 'typed parameters: bound as ?, the unset slot takes the template default');
has('query A=r1', 'trailing blanks of a text column are cut');
has('query N=---', 'a null text column is ---');
has('xpath C1=2', 'XPath: a location path ending with "/" counts the rows (count(/Rowsets/Rowset/Row/))');
has('xpath C2=1', 'getlistfromxpath with count(): one element with the number');
has('xpath C3=0.75', 'XPath: a number result as text');
has('xpath C4=2', 'XPath: line breaks between tokens');
has('star Dyn1=id:I1', '#Repeater.Item{xpath}# is the value of the loop item');
has('star Dyn2=q:5', '#Action.Results{xpath}# is the value of the action result');
has('star Dyn4=last:I1', '#Repeater.Item# after its loop is the last item');
has('star Dyn3=ab', '#Iterator.CurrentItem# is the current element');
has('star Txt=<Row><INVENTORY_ID>I1</INVENTORY_ID><QTY_ON_HAND>5</QTY_ON_HAND></Row>', 'select *: the row record without columns stands for the Row read (repeater item)');
has('regex R1=ResourceBO', 'Java regex: possessive quantifier :.*+$');
has('regex R2=true', 'Java regex: POSIX class \\p{Lower}');
has('regex R3=a-c', 'Java regex: \\Q...\\E');
has('regex I1=5', 'stringindexof counts from 1 (stringindexof("football", "ball") = 5, measured on MII)');
has('regex I2=0', 'stringindexof gives 0 for a missing part');
has('regex I3=4', 'stringlastindexof counts from 1');
has('regex A1=5', 'append(list, value1, ...) appends every value');
has('regex R4=true','Java regex: a backslash before _ quotes it (.NET refuses \\_)');
has('formats D=2026-10-28T10:00:00', 'Query.DateFormat is the template DateFormat (not unresolved)');
has('formats DT=2026-10-28T10:00:00', 'a date link into a dateTime output converts');
has('formats F=2.68', 'NumberFormat 0.00 rounds half-even (2.675 -> 2.68)');
has('formats G=1.00', 'NumberFormat 0.00 rounds half-even (1.005 -> 1.00)');
has('formats I=12', 'NumberFormat leaves integer values');
has('multi M1=2', 'several result sets: one Rowset each (count(/Rowsets/Rowset[2]/Row))');
has('multi M2=y', 'several result sets: a value of the second Rowset');
has('multi D1=TimeUnavailable', 'a NULL date column is TimeUnavailable');
has('multi NB=true', 'END_DATE_TIME == "TimeUnavailable" holds for a NULL date');
has('multi CT=true', 'first(getlistfromxpath(rows, "count(...)")) > 0 compares the count as a number');
has('multi RC=1', 'rows typed by a reference document keep the columns the record does not know');
has('xml Sum=12', 'a repeater item keeps the namespace declarations in scope (p:)');
has('xml Appended=2', 'Append XML of Doc{xpath} appends the selected nodes');
matches(/^xml PLUGIN Distinct Unique .*ValueSource=<Nodes><i>1<\/i><i>2<\/i><\/Nodes>/, 'Distinct gets the value of its ValueSource reference, not the text');
has('xml Num=0', 'NA (the null of a number) linked into a double gives 0 (assumed)');
matches(/^xml PLUGIN Joiner Join .*ParentSource=<r><i>1<\/i>/,'Joiner gets the value of its ParentSource reference');
has('xml DY=x-Z-y', '#Local.Name# in a regular expression is the value of the local');
matches(/^xsl ERROR .*without a stylesheet/, 'an XSL transformation without a stylesheet fails with a clear message');
has('formats F2=2.7','the action XmlNumberFormat 0.0 wins over the template NumberFormat');
console.log(failures === 0 ? 'OK (' + simulationFile + ')' : failures + ' failure(s), see ' + join(workFolder, 'output.txt'));
process.exit(failures === 0 ? 0 : 1);
