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

/** Calls a transaction, then sets After and reads the call; a Catch at the end notes what it caught. */
function callAndCatch(callee) {
  return trx({
    outputs: [['After', 'string', ''], ['Marker', 'string', ''], ['Msg', 'string', ''], ['Ok', 'string', ''], ['Caught', 'string', 'no'], ['Type', 'string', ''], ['Src', 'string', ''], ['Text', 'string', '']],
    actions: [['CallIt', 'TransactionCall', { TransactionName: callee, ResetState: 'true' }], ['Collect', 'Assignment', {}], ['Catch', 'CatchAction', {}], ['Handler', 'Assignment', {}]],
    steps: [
      step('ActionSequence', 'Sequence_1', { name: 'CallIt' }),
      step('ActionSequence', 'Sequence_2', {
        name: 'Collect',
        outgoing: [['Transaction.After', '"ok"'], ['Transaction.Marker', 'CallIt.Marker'], ['Transaction.Msg', 'CallIt.LastErrorMessage'], ['Transaction.Ok', 'CallIt.Success']],
      }),
      step('Catch', 'Sequence_3', { name: 'Catch', outgoing: [['Transaction.Type', 'Catch.ExceptionType'], ['Transaction.Src', 'Catch.Source'], ['Transaction.Text', 'Catch.Message']] },
        [step('ActionSequence', 'Sequence_4', { name: 'Handler', outgoing: [['Transaction.Caught', '"yes"']] })]),
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
  // 2.8.0: behaviour measured on MII 15.5 SP1 (Definitive Guide of 2026-11-23)
  'SIM/trxThrower.trx': trx({
    outputs: [['Marker', 'string', '']],
    actions: [['Mark', 'Assignment', {}], ['Boom', 'Throw', { Message: 'boom', Enable: 'true' }]],
    steps: [step('ActionSequence', 'Sequence_1', { name: 'Mark', outgoing: [['Transaction.Marker', '"set"']] }), step('ActionSequence', 'Sequence_2', { name: 'Boom' })],
  }),
  'SIM/trxFailer.trx': trx({
    outputs: [['Marker', 'string', '']],
    actions: [['Mark', 'Assignment', {}], ['Stop', 'TerminateTransaction', { TerminateWithError: 'true', TerminationMessage: 'stopped' }]],
    steps: [step('ActionSequence', 'Sequence_1', { name: 'Mark', outgoing: [['Transaction.Marker', '"set"']] }), step('ActionSequence', 'Sequence_2', { name: 'Stop' })],
  }),
  'SIM/trxUncaught.trx': callAndCatch('SIM/trxThrower'),
  'SIM/trxFailed.trx': callAndCatch('SIM/trxFailer'),
  'SIM/trxThrowCaught.trx': trx({
    outputs: [['Type', 'string', ''], ['Src', 'string', ''], ['Text', 'string', '']],
    actions: [['Boom', 'Throw', { Message: 'boom', Enable: 'true' }], ['Catch', 'CatchAction', {}]],
    steps: [
      step('ActionSequence', 'Sequence_1', { name: 'Boom' }),
      step('Catch', 'Sequence_2', { name: 'Catch', outgoing: [['Transaction.Type', 'Catch.ExceptionType'], ['Transaction.Src', 'Catch.Source'], ['Transaction.Text', 'Catch.Message']] }),
    ],
  }),
  'SIM/trxReqCallee.trx': trx({
    inputs: [['Request', 'xml', '<Req><Sfc/><Keep>default</Keep></Req>']],
    outputs: [['Echo', 'string', '']],
    actions: [['Read', 'Assignment', {}]],
    steps: [step('ActionSequence', 'Sequence_1', { name: 'Read', outgoing: [['Transaction.Echo', 'Transaction.Request{/Req/Sfc} & "|" & Transaction.Request{/Req/Keep}']] })],
  }),
  'SIM/trxReqCaller.trx': trx({
    outputs: [['Echo', 'string', '']],
    actions: [['CallReq', 'TransactionCall', { TransactionName: 'SIM/trxReqCallee', ResetState: 'true', Request: '<Req><Sfc/><Keep>stored</Keep></Req>' }]],
    steps: [step('ActionSequence', 'Sequence_1', { name: 'CallReq', incoming: [['CallReq.Request{/Req/Sfc}', '"S1"']], outgoing: [['Transaction.Echo', 'CallReq.Echo']] })],
  }),
  'SIM/trxExpr.trx': trx({
    outputs: ['M1', 'M2', 'N1', 'N2', 'N3', 'B1', 'D1', 'D2', 'E1', 'E2', 'C1', 'K1', 'K2', 'G1', 'G2', 'R1', 'R2', 'S1', 'P1', 'A1', 'T1', 'X1', 'NS', 'RD', 'L1', 'D3', 'D4', 'Q1'].map((name) => [name, 'string', '?']),
    locals: [['M', 'map', '{Present=[string:yes]}'], ['Req', 'xml', '<Envelope><Body><requests/></Body></Envelope>'],
      ['Tpl', 'xml', '<Template><requests><request>1</request></requests></Template>']],
    actions: [['Work', 'Assignment', {}]],
    steps: [step('ActionSequence', 'Sequence_1', {
      name: 'Work',
      outgoing: [
        ['Transaction.M1', 'match("abc", "ABC")'], ['Transaction.M2', 'match("abc", "(?-i)ABC")'],
        ['Transaction.N1', 'number("12abc")'], ['Transaction.N2', 'number("1,5")'], ['Transaction.N3', 'number("1e3")'],
        ['Transaction.B1', '"" & (1 < 2)'], ['Transaction.D1', '"" & (4 / 2)'], ['Transaction.D2', '"" & (1 / 0)'],
        ['Transaction.E1', '5 == "5.0"'], ['Transaction.E2', '"5.0" == 5'], ['Transaction.C1', '"" < 1'],
        ['Transaction.K1', 'listtostring(keys(map("Sfc", "1", "Site", "2", "Operation", "3")), ",")'],
        ['Transaction.K2', 'listtostring(keys(liststomap(list("Sfc", "Site", "Operation"), list("1", "2", "3"))), ",")'],
        ['Transaction.G1', 'getvaluefromMap(Local.M, "Missing")'], ['Transaction.G2', '"[" & Local.M{Missing} & "]"'],
        ['Transaction.R1', 'stringreplaceall("a-b", "-", "x y")'], ['Transaction.R2', 'stringreplaceall("a-b", "-", " z ")'],
        ['Transaction.S1', 'listtostring(stringtolist("a, b,,", ","), "|")'], ['Transaction.P1', '2 ^ 3 ^ 2'], ['Transaction.A1', '"2.5" + 1'],
        ['Transaction.T1', 'stringlength("a\\tb")'],
        ['Local.Req{/Envelope/Body}', 'Local.Tpl{/Template}', 'AssignXml'], ['Transaction.X1', 'Local.Req{name(/Envelope/*)}'],
        ['Transaction.NS', 'nullstring'], ['Transaction.RD', 'round(0 - 2.5)'], ['Transaction.L1', '"" & list("a", "b")'],
        ['Transaction.D3', '"" & (0.1 + 0.2)'], ['Transaction.D4', '"" & (10 ^ 20)'], ['Transaction.Q1', '(1 == 1) || (1 == 1) && (1 == 2)'],
      ],
    })],
  }),
  // 2.8.1: XML links with a text source, measured on MII 15.5 SP1 Patch 23 (ZZ_RETEST3 of 2026-11-26, cases A to H)
  'SIM/trxXmlText.trx': trx({
    outputs: ['A1', 'A2', 'B1', 'B2', 'C1', 'D1', 'D2', 'E1', 'E2', 'F1', 'F2', 'G1', 'G2', 'H1', 'H2', 'R1', 'Done'].map((name) => [name, 'string', '?']),
    locals: [['Sfcs', 'string', '<Sfcs><Sfc>SFC1</Sfc><Sfc>SFC2</Sfc></Sfcs>'], ['Plain', 'string', 'plain text'], ['Amp', 'string', '<Sfcs><Sfc>A&B</Sfc></Sfcs>'],
      ['Empty', 'string', ''], ['DocA', 'xml', '<Root><Sfcs/></Root>'], ['DocB', 'xml', '<Root><Sfcs/></Root>'], ['DocC', 'xml', '<Old/>'],
      ['DocD', 'xml', '<Root><Sfcs><Sfc>SFC1</Sfc></Sfcs></Root>'], ['DocE', 'xml', '<Root><Sfcs/></Root>'], ['DocF', 'xml', '<Root><Sfcs>keep</Sfcs></Root>'],
      ['DocF2', 'xml', '<Old/>'], ['DocG', 'xml', '<Root><Sfcs>keep</Sfcs></Root>'], ['DocG2', 'xml', '<Root><Sfcs>keep</Sfcs></Root>'],
      ['DocH', 'xml', '<Root><Sfcs>keep</Sfcs></Root>'], ['DocH2', 'xml', '<Old/>'], ['DocR', 'xml', '<Root><Sfcs>old</Sfcs></Root>']],
    actions: [['Work', 'Assignment', {}]],
    steps: [step('ActionSequence', 'Sequence_1', {
      name: 'Work',
      outgoing: [
        ['Local.DocA{/Root/Sfcs}', 'Local.Sfcs', 'AssignXml'], ['Transaction.A1', 'Local.DocA{count(/Root/Sfcs/Sfc)}'], ['Transaction.A2', 'Local.DocA'],
        ['Local.DocB{/Root/Sfcs}', 'Local.Sfcs'], ['Transaction.B1', 'Local.DocB{count(/Root/Sfcs/*)}'], ['Transaction.B2', 'Local.DocB{/Root/Sfcs}'],
        ['Local.DocC', 'Local.Sfcs', 'AssignXml'], ['Transaction.C1', 'Local.DocC'],
        ['Local.DocD{/Root/Sfcs}', '"<Flag>true</Flag>"', 'AppendXml'], ['Transaction.D1', 'Local.DocD{name(/Root/Sfcs/*[last()])}'], ['Transaction.D2', 'Local.DocD'],
        ['Local.DocE{/Root/Sfcs}', '"<Other><X>1</X></Other>"', 'AssignXml'], ['Transaction.E1', 'Local.DocE{name(/Root/*)}'], ['Transaction.E2', 'Local.DocE'],
        ['Local.DocF{/Root/Sfcs}', 'Local.Plain', 'AssignXml'], ['Transaction.F1', 'Local.DocF'],
        ['Local.DocF2', 'Local.Plain', 'AssignXml'], ['Transaction.F2', 'Local.DocF2'],
        ['Local.DocG{/Root/Sfcs}', 'Local.Amp', 'AssignXml'], ['Transaction.G1', 'Local.DocG'],
        ['Local.DocG2{/Root/Sfcs}', 'Local.Amp', 'AppendXml'], ['Transaction.G2', 'Local.DocG2'],
        ['Local.DocH{/Root/Sfcs}', 'Local.Empty', 'AssignXml'], ['Transaction.H1', 'Local.DocH'],
        ['Local.DocH2', 'Local.Empty', 'AssignXml'], ['Transaction.H2', 'Local.DocH2'],
        ['Local.DocR{/Root/Sfcs}', '"<New/>"', 'ReplaceXml'], ['Transaction.R1', 'Local.DocR'],
        ['Transaction.Done', '"yes"'],
      ],
    })],
  }),
  'SIM/trxReqText.trx': trx({
    outputs: [['Echo1', 'string', ''], ['Echo2', 'string', '']],
    locals: [['Plain', 'string', 'plain text'], ['Req', 'string', '<Req><Sfc>S9</Sfc><Keep>text</Keep></Req>']],
    actions: [['CallPlain', 'TransactionCall', { TransactionName: 'SIM/trxReqCallee', ResetState: 'true' }], ['CallText', 'TransactionCall', { TransactionName: 'SIM/trxReqCallee', ResetState: 'true' }]],
    steps: [
      step('ActionSequence', 'Sequence_1', { name: 'CallPlain', incoming: [['CallPlain.Request', 'Local.Plain', 'AssignXml']], outgoing: [['Transaction.Echo1', 'CallPlain.Echo']] }),
      step('ActionSequence', 'Sequence_2', { name: 'CallText', incoming: [['CallText.Request', 'Local.Req', 'AssignXml']], outgoing: [['Transaction.Echo2', 'CallText.Echo']] }),
    ],
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
        Run("uncaught", "SIM/trxUncaught", []);
        Run("failed", "SIM/trxFailed", []);
        Run("thrower", "SIM/trxThrower", []);
        Run("failer", "SIM/trxFailer", []);
        Run("throwcaught", "SIM/trxThrowCaught", []);
        Run("req", "SIM/trxReqCaller", []);
        Run("expr", "SIM/trxExpr", []);
        Run("xmltext", "SIM/trxXmlText", []);
        Run("reqtext", "SIM/trxReqText", []);
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
matches(/^link1 DIAG .*status Terminated.*Conversion Exception/, 'ThrowOnLinkError 1: the failing link raises the exception; nothing catches it, the run ends Terminated');
has('link1 Num=42', 'ThrowOnLinkError 1: the entry run returns the outputs as they are (no error for the caller)');
has('notrun0 Res=keep', 'a link to an output of an action that did not run fails; ThrowOnLinkError 0 keeps the target');
has('notrun0 After=done', 'ThrowOnLinkError 0: the later link still runs');
matches(/^notrun1 DIAG .*status Terminated.*Invalid variable: CallNotRun/, 'ThrowOnLinkError 1: "Invalid variable" raises the exception (run Terminated)');
has('notrun1 Res=keep', 'ThrowOnLinkError 1: the target of the failing link keeps its value');
has('action0 Res=after', 'ThrowOnActionError 0: the run goes on after the failing action');
matches(/^action0 DIAG .*plugin failed/, 'ThrowOnActionError 0: the action error is recorded');
matches(/^action1 DIAG .*status Terminated.*plugin failed/, 'ThrowOnActionError 1: the failing action raises the exception (run Terminated)');
has('action1 Res=', 'ThrowOnActionError 1: the step after the failing action is skipped');
has("query SQL select 'x' as A, 'dflt' as B, '' as C, N from DUMMY VALUES ", 'text parameters: set value, template default, unset slot without default is ""');
has('query SQL select A, N from T where A = ? and B = ? VALUES Int64:5,String:z', 'typed parameters: bound as ?, the unset slot takes the template default');
has('query A=r1', 'a text column is trimmed');
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
has('regex R2=1', 'Java regex: POSIX class \\p{Lower} (a boolean as text is 1)');
has('regex R3=a-c', 'Java regex: \\Q...\\E');
has('regex I1=5', 'stringindexof counts from 1 (stringindexof("football", "ball") = 5, measured on MII)');
has('regex I2=0', 'stringindexof gives 0 for a missing part');
has('regex I3=4', 'stringlastindexof counts from 1');
has('regex A1=5', 'append(list, value1, ...) appends every value');
has('regex R4=1','Java regex: a backslash before _ quotes it (.NET refuses \\_)');
has('formats D=2026-10-28T10:00:00', 'Query.DateFormat is the template DateFormat (not unresolved)');
has('formats DT=2026-10-28T10:00:00', 'a date link into a dateTime output converts');
has('formats F=2.68', 'NumberFormat 0.00 rounds half-even (2.675 -> 2.68)');
has('formats G=1.00', 'NumberFormat 0.00 rounds half-even (1.005 -> 1.00)');
has('formats I=12', 'NumberFormat leaves integer values');
has('multi M1=2', 'several result sets: one Rowset each (count(/Rowsets/Rowset[2]/Row))');
has('multi M2=y', 'several result sets: a value of the second Rowset');
has('multi D1=TimeUnavailable', 'a NULL date column is TimeUnavailable');
has('multi NB=1', 'END_DATE_TIME == "TimeUnavailable" holds for a NULL date');
has('multi CT=1', 'first(getlistfromxpath(rows, "count(...)")) > 0 compares the count as a number');
has('multi RC=1', 'rows typed by a reference document keep the columns the record does not know');
has('xml Sum=12', 'a repeater item keeps the namespace declarations in scope (p:)');
has('xml Appended=2', 'Append XML of Doc{xpath} appends the selected nodes');
matches(/^xml PLUGIN Distinct Unique .*ValueSource=<Nodes><i>1<\/i><i>2<\/i><\/Nodes>/, 'Distinct gets the value of its ValueSource reference, not the text');
has('xml Num=0', 'NA (the null of a number) linked into a double gives 0 (assumed)');
matches(/^xml PLUGIN Joiner Join .*ParentSource=<r><i>1<\/i>/,'Joiner gets the value of its ParentSource reference');
has('xml DY=x-Z-y', '#Local.Name# in a regular expression is the value of the local');
matches(/^xsl DIAG .*without a stylesheet/, 'an XSL transformation without a stylesheet fails with a clear message');
has('formats F2=2.7','the action XmlNumberFormat 0.0 wins over the template NumberFormat');
// 2.8.0: measured on MII 15.5 SP1 (ZZ_RETEST, ZZ_RETEST2 of 2026-11-23)
has('uncaught After=ok', 'callee with an uncaught exception: the caller goes on (ERR-3)');
has('uncaught Caught=no', 'callee with an uncaught exception: the caller\'s Catch does not run');
has('uncaught Marker=set', 'callee with an uncaught exception: its outputs are returned as they are');
has('uncaught Msg=boom', 'callee with an uncaught exception: the message is in LastErrorMessage of the call');
has('uncaught Ok=1', 'callee with an uncaught exception: Success of the call is true');
has('thrower Marker=set', 'entry run with an uncaught exception: the outputs are returned, no error (ERR-1, ERR-4)');
has('failed Caught=yes', 'callee ended by Terminate with error: the caller\'s Catch runs');
has('failed After=', 'callee ended by Terminate with error: the step after the call is skipped');
has('failed Type=ACTION_FAILURE', 'Catch.ExceptionType of a failed call is ACTION_FAILURE');
has('failed Src=CallIt', 'Catch.Source of a failed call is the call action');
has('failed Text=stopped', 'Catch.Message of a failed call is the termination message');
matches(/^failer ERROR stopped/, 'entry run ended by Terminate with error: the run fails with the message');
has('throwcaught Type=USER_EXCEPTION', 'Catch.ExceptionType of a Throw is USER_EXCEPTION');
has('throwcaught Src=Boom', 'Catch.Source of a Throw is the Throw action');
has('req Echo=S1|default', 'a call XML input filled by an element link starts from the callee default (CALL-4)');
has('expr M1=1', 'match() ignores case (EXP-1)');
has('expr M2=0', '(?-i) makes match() case-sensitive (M2-4)');
has('expr N1=12', 'number("12abc") is 12 (NUM-2)');
has('expr N2=15', 'number("1,5") is 15 (NUM-7)');
has('expr N3=1', 'number("1e3") is 1 (NUM-5)');
has('expr B1=1', 'a boolean as text is 1');
has('expr D1=2', 'a double as text has no .0 (4 / 2 is 2)');
has('expr D2=NA', 'a division by zero is NA');
has('expr E1=1', '5 == "5.0" is true (the right side becomes a number)');
has('expr E2=0', '"5.0" == 5 is false (the right side becomes the text 5)');
has('expr C1=0', '"" < 1 is false (an empty side is not-a-number)');
has('expr K1=Site,Sfc,Operation', 'map(): keys in hash order (EXP-2)');
has('expr K2=Site,Sfc,Operation', 'liststomap(): keys in hash order, not sorted (EXP-2)');
has('expr G1=null', 'getvaluefromMap of a missing key is the text null (MAP-1)');
has('expr G2=[]', 'Map{Missing} is empty (MAP-2)');
has('expr R1=ax yb', 'stringreplaceall keeps a blank inside the replacement (EXP-4)');
has('expr R2=azb', 'stringreplaceall trims the replacement (EXP-4)');
has('expr S1=a|b', 'stringtolist trims the parts and drops empty parts at the end');
has('expr P1=64', '2 ^ 3 ^ 2 is 64 (left-associative)');
has('expr A1=3', '"2.5" + 1 is 3 (a text added to a whole number is cut first)');
has('expr T1=3', '\\t in a literal is a tab (EXP-3)');
has('expr X1=Template', 'Assign XML at an XPath replaces the target element by the source element (XML-1)');
has('expr NS=---', 'nullstring is ---');
has('expr RD=-2', 'round(-2.5) is -2 (a half goes up)');
has('expr L1=[[string:a], [string:b]]', 'a list as text is [[string:a], [string:b]]');
has('expr D3=0.3', 'a double as text has at most 12 decimals (0.1 + 0.2 is 0.3)');
has('expr D4=100000000000000000000', 'a double as text has no exponent');
has('expr Q1=0', '&& and || share one level, left to right: (A || B) && C');
// 2.8.1: XML links with a text source, measured on MII 15.5 SP1 Patch 23 (ZZ_RETEST3 of 2026-11-26)
has('xmltext A1=2', 'A: Assign XML of well-formed text to an XPath gives elements (count 2)');
has('xmltext A2=<Root><Sfcs><Sfc>SFC1</Sfc><Sfc>SFC2</Sfc></Sfcs></Root>', 'A: the target element is replaced by the parsed root element');
has('xmltext B1=0', 'B: Assign of the same text to an XPath gives no elements');
has('xmltext B2=<Sfcs><Sfc>SFC1</Sfc><Sfc>SFC2</Sfc></Sfcs>', 'B: the markup arrives as the text of the node');
has('xmltext C1=<Sfcs><Sfc>SFC1</Sfc><Sfc>SFC2</Sfc></Sfcs>', 'C: Assign XML of well-formed text without an XPath makes the local the parsed document');
has('xmltext D1=Flag', 'D: Append XML of well-formed text appends the parsed root element as last child');
has('xmltext D2=<Root><Sfcs><Sfc>SFC1</Sfc><Flag>true</Flag></Sfcs></Root>', 'D: the children before stay');
has('xmltext E1=Other', 'E: Assign XML of a text with another root name replaces the target element, the source\'s name wins');
has('xmltext E2=<Root><Other><X>1</X></Other></Root>', 'E: the parsed element stands in the place of the target element');
has('xmltext F1=<Root><Sfcs>keep</Sfcs></Root>', 'F: Assign XML of plain text has no effect');
has('xmltext F2=<Old />', 'F: Assign XML of plain text without an XPath leaves the local as it is');
has('xmltext G1=<Root><Sfcs>keep</Sfcs></Root>', 'G: Assign XML of a text with a raw & has no effect');
has('xmltext G2=<Root><Sfcs>keep</Sfcs></Root>', 'G: Append XML of a text with a raw & has no effect');
has('xmltext H1=<Root><Sfcs>keep</Sfcs></Root>', 'H: Assign XML of an empty text has no effect');
has('xmltext H2=<Old />', 'H: Assign XML of an empty text without an XPath leaves the local as it is');
has('xmltext R1=<Root><Sfcs><New /></Sfcs></Root>', 'Replace XML of well-formed text puts the parsed root element into the selected node');
has('xmltext Done=yes', 'F, G, H: no exception, the links after them run');
has('reqtext Echo1=|default', 'Assign XML of plain text into an XML input of a call: the input keeps the callee default');
has('reqtext Echo2=S9|text', 'Assign XML of well-formed text into an XML input of a call: the input is the parsed document');
console.log(failures === 0 ? 'OK (' + simulationFile + ')' : failures + ' failure(s), see ' + join(workFolder, 'output.txt'));
process.exit(failures === 0 ? 0 : 1);
