// The generated file (C# 12): header, the logic class with one method per transaction, the records (results and
// rows), the service interfaces and the runtime.
import { MiiQueryKind } from './model.js';
import { GenerationContext, ContractBuilder } from './contracts.js';
import { TransactionEmitter, indent } from './emitter.js';
import { addBlankLines } from './placer.js';
import { TypeKind, Naming, UniqueNames, CsLiteral, DEFAULT_LIMIT, limitedDefault } from './types.js';
import { ObjectPath } from './sources.js';
import { webFilePath } from './staticfiles.js';

export const TOOL_VERSION = '2.7.1';

const xmlText = (text) => (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Generates the file. runtimeText is the C# source of the runtime (RuntimeSource.txt), now the generation time. */
export function generateCode(graph, sourceDescription, runtimeText, now) {
  const context = new GenerationContext(graph);
  ContractBuilder.build(context);
  context.queries.forEach((contract, query) => {
    contract.fileConstant = query.kind === MiiQueryKind.Xml ? context.fileConstant(webFilePath(query.url)) : null;
  });

  // methods first: they complete the row records (columns read by XPath)
  const methods = [];

  for (const transaction of graph.transactions) {
    const contract = context.transactions.get(transaction);
    methods.push('', ...new TransactionEmitter(context, contract).emitMethod(graph.roots.includes(transaction)));
  }

  const folderMode = graph.folder !== null;
  const root = graph.root ? context.transactions.get(graph.root) : null;
  const fileName = folderMode ? Naming.pascal(ObjectPath.leaf(graph.folder)).replace(/^@/, '') : root.methodName;
  const queryMethods = [];

  // query templates of the folder that no transaction runs: a public method each
  for (const query of graph.folderQueries) {
    const contract = context.queries.get(query);

    if (contract.callers.length === 0 && (query.kind === MiiQueryKind.Sql || query.kind === MiiQueryKind.Mdo)) {
      const methodName = context.methodNames.claim(Naming.pascal(query.shortName).replace(/^@/, ''));
      queryMethods.push(methodName);
      methods.push('', ...queryMethod(contract, methodName));
    }
  }

  const summary = folderMode
    ? 'The logic of the folder ' + xmlText(graph.folder) + ': its transactions and query templates (public) and every transaction they call, one method each.'
    : 'The logic of ' + xmlText(root.transaction.path) + ' and of every transaction it calls, one method each.';
  const lines = [
    ...(folderMode ? folderHeader(context, queryMethods, sourceDescription, now) : header(context, root, sourceDescription, now)),
    '#nullable disable',
    '',
    'using System;',
    'using System.Collections.Generic;',
    'using System.Globalization;',
    'using System.IO;',
    'using System.Linq;',
    'using System.Reflection;',
    'using System.Text;',
    'using System.Text.RegularExpressions;',
    'using System.Threading;',
    'using System.Xml;',
    'using System.Xml.Xsl;',
    '',
    'namespace XRay.' + fileName + ';',
    '',
    '/// <summary>',
    '/// ' + summary,
    '/// </summary>',
    'public sealed class ' + context.className + '(IQueryService queries, IPluginService plugins)',
    '{',
    ...indent(methods.slice(1)),
    '}',
    ...records(context),
    ...filesClass(context),
    '',
    ...runtimeText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd().split('\n'),
  ];

  const code = addBlankLines(lines.flatMap(commentContinued)).join('\n').replace(/\r\n/g, '\n');
  return {
    code: code.replace(/\n/g, '\r\n') + '\r\n',
    rootName: fileName,
    folder: graph.folder,
    transactionCount: graph.transactions.length,
    queryCount: graph.queries.length,
    missing: graph.missing.slice(),
    notes: context.notes.slice(),
  };
}

function header(context, root, sourceDescription, now) {
  const rule = '// ' + '='.repeat(110);
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());
  const lines = [
    rule,
    '// MII X-Ray of ' + root.transaction.path,
    '// Generated ' + stamp + ' by MII X-Ray ' + TOOL_VERSION + ' from ' + sourceDescription,
    '//',
    '// The logic of the transaction and of every transaction and query it uses, as C# 12 (.NET 8). It shows what the',
    '// code does, not how MII runs it: MII settings stand as comments at the actions, default values are set as in MII,',
    '// a called transaction is a method, a query goes through IQueryService, an MII action without a C# equivalent through',
    '// IPluginService.',
    '// The Mii class at the end implements the MII expression functions and the XML handling.',
    '//',
    '// Entry point: new ' + context.className + '(queries, plugins).' + root.methodName + '(...)',
    '//',
    ...readingRules(),
    '//',
    '// Transactions (' + context.graph.transactions.length + '):',
  ];

  for (const transaction of context.graph.transactions) {
    lines.push('//   ' + context.transactions.get(transaction).methodName + ' = ' + transaction.path);
  }

  lines.push('//');
  lines.push(CALL_TREE_TITLE);
  lines.push('//   ' + root.methodName);
  callTree(root, '//     ', [], lines);
  return headerTail(context, lines, rule);
}

const CALL_TREE_TITLE = '// Call tree (execution order; [if X], [else X], [case n of X], [loop X] = once per item, [on error X] = in the handler of the catch X):';

/** The header of a folder X-Ray: every transaction of the folder is an entry point. */
function folderHeader(context, queryMethods, sourceDescription, now) {
  const graph = context.graph;
  const rule = '// ' + '='.repeat(110);
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());
  const roots = graph.roots.map((transaction) => context.transactions.get(transaction));
  const lines = [
    rule,
    '// MII X-Ray of the folder ' + graph.folder + ' (with its subfolders)',
    '// Generated ' + stamp + ' by MII X-Ray ' + TOOL_VERSION + ' from ' + sourceDescription,
    '//',
    '// The logic of every transaction and query template in the folder and of every transaction and query they use, as',
    '// C# 12 (.NET 8). It shows what the code does, not how MII runs it: MII settings stand as comments at the actions,',
    '// default values are set as in MII, a called transaction is a method, a query goes through IQueryService, an MII action without a C# equivalent',
    '// through IPluginService. The Mii class at the end implements the MII expression functions and the XML handling.',
    '//',
    '// Entry points: new ' + context.className + '(queries, plugins).<Method>(...), one public method per transaction of the',
    '// folder (' + roots.length + ')' + (queryMethods.length > 0 ? ' and per query template of the folder that no transaction runs (' + queryMethods.length + ')' : '')
      + '; the other methods are transactions outside the folder that these call.',
    '//',
    ...readingRules(),
    '//',
    '// Transactions (' + graph.transactions.length + ', ' + roots.length + ' in the folder):',
  ];

  for (const transaction of graph.transactions) {
    lines.push('//   ' + context.transactions.get(transaction).methodName + ' = ' + transaction.path + (graph.roots.includes(transaction) ? '' : '  (outside the folder)'));
  }

  if (queryMethods.length > 0) {
    lines.push('//', '// Query templates of the folder that no transaction runs (a public method each): ' + queryMethods.join(', '));
  }

  if (roots.length > 0) {
    // one tree per transaction no other transaction calls; a transaction already shown is not expanded again
    const called = new Set();
    context.transactions.forEach((contract) => contract.outline.forEach((entry) => {
      if (entry.callee && entry.callee !== contract) {
        called.add(entry.callee);
      }
    }));
    const expanded = [];
    lines.push('//', CALL_TREE_TITLE);

    for (const contract of roots.filter((candidate) => !called.has(candidate)).concat(roots.filter((candidate) => called.has(candidate)))) {
      if (!expanded.includes(contract)) {
        lines.push('//   ' + contract.methodName);
        callTree(contract, '//     ', expanded, lines);
      }
    }
  }

  return headerTail(context, lines, rule);
}

/** Queries, objects not found and notes: the end of both headers. */
function headerTail(context, lines, rule) {
  if (context.graph.queries.length > 0) {
    lines.push('//', '// Queries (' + context.graph.queries.length + '):');

    for (const query of context.graph.queries) {
      lines.push(...queryOverview(context.queries.get(query)));
    }
  }

  if (context.graph.files.size > 0) {
    lines.push('//', '// Web files the transactions name (content in the class MiiFiles at the end):');

    for (const path of context.graph.files.keys()) {
      const constant = context.fileConstant(path);
      lines.push('//   ' + path + ' = ' + (constant !== null ? constant : '(not found on the server)'));
    }
  }

  if (context.graph.sharedProperties.length > 0) {
    lines.push('//', '// Shared properties the transactions use (definition and default value from <Project>/META-INF/SharedProperties.mem):');

    for (const property of context.graph.sharedProperties) {
      lines.push(...sharedPropertyOverview(property));
    }
  }

  if (context.graph.missing.length > 0) {
    lines.push('//', '// Not found (called through IPluginService instead):');
    context.graph.missing.forEach((missing) => lines.push('//   ' + missing));
  }

  if (context.notes.length > 0) {
    lines.push('//', '// Notes (' + context.notes.length + '):');
    context.notes.forEach((note) => lines.push('//   ' + note));
  }

  lines.push(rule, '');
  return lines;
}

/** A query template no transaction runs, as a method: its parameters are the query parameters. */
function queryMethod(contract, methodName) {
  const query = contract.query;
  const names = new UniqueNames();
  ['queries', 'plugins'].forEach((name) => names.reserve(name));
  const parameters = contract.parameters.map((parameter) => ({ parameter, name: names.claim(Naming.camel(parameter.name)) }));
  const variable = names.claim(contract.variableName);
  const command = query.mode.toLowerCase() === 'command';
  const head = 'public ' + (command ? 'void' : contract.result.rowsetTypeName) + ' ' + methodName + '(';
  const declarations = parameters.map((item) => 'string ' + item.name + ' = default');
  const lines = ['/// <summary>', '/// ' + xmlText(query.path) + ' (query template, no transaction runs it)', '/// </summary>'];

  if (declarations.length <= 3) {
    lines.push(head + declarations.join(', ') + ')');
  } else {
    lines.push(head, ...declarations.map((declaration, index) => '    ' + declaration + (index < declarations.length - 1 ? ',' : ')')));
  }

  const body = [];

  if (parameters.length > 0) {
    body.push(contract.parameterComment());
  }

  body.push('var ' + variable + ' = new Query(' + CsLiteral.string(query.text) + ');');
  parameters.forEach((item) => body.push(contract.addParameterCode(variable, item.parameter, item.name)));

  if (!command && /^\s*[1-9]\d*\s*$/.test(query.rowCount)) {
    body.push(variable + '.RowCount = ' + query.rowCount.trim() + ';');
  }
  body.push(command ? 'queries.ExecuteCommand(' + variable + ');' : 'return queries.Execute<' + contract.result.rowTypeName + '>(' + variable + ');');
  lines.push('{', ...indent(body), '}');
  return lines;
}

function readingRules() {
  return [
    '// How to read this file:',
    '//   - Every MII transaction is a method: its parameters are the MII inputs, its return value the MII outputs (a',
    '//     record when there are several). A caller passes the inputs it links; an input it does not link has its MII',
    '//     default (the parameter default; for XML, lists, maps and dates the first lines of the method set it).',
    '//   - A query is a local Query variable: its text is the MII template text; the comment above it maps [Param.N] to',
    '//     the names. AddParameter(name, value): a text parameter (Use Typed Parameters off), MII replaces [Param.N] by the',
    '//     value as text; quoting and escaping are done by the template and the callers (e.g. Mii.StringReplace(x, "\'", "\'\'")).',
    '//     AddTypedParameter(name, type, value): Use Typed Parameters on, MII checks the value against the type and binds',
    '//     it as a statement parameter; an unquoted [Param.N] is right there, a quoted one is no parameter (notes).',
    '//   - A comment at a declaration gives the exact MII name (case as in MII) and the MII type: Transaction.X for an',
    '//     input or output, Local.X, action X for the result of an action, column X for a column. Outputs and locals start',
    '//     with their MII default. The comment gives the default only where the code does not hold it (a local declared',
    '//     where the flow sets it, a value C# cannot take as it is). A default larger than ' + (DEFAULT_LIMIT / 1024) + ' KB is not in the file: it',
    '//     stands as [n-bytes] (n = its size in UTF-8 bytes).',
    '//   - "MII settings" under an action name list every configured property of the action as MII stores it ("linked":',
    '//     a link sets it at runtime, the code shows that), without the results of the last test run.',
    '//   - Query.RowCount is MII\'s RowCount: the query returns at most that many rows and drops the rest without a message.',
    '//   - MII rowset documents are lists of row records; FirstOrEmpty() and RowAt(n) give an empty row instead of null.',
    '//   - Conditions combine with & and |, not && and ||: MII evaluates every part (a later part is no guard).',
    '//   - Mii.If is MII\'s if(): it returns a number, also for text branches (stringif returns text).',
    '//   - A catch handles every action before it in the same block (MII Catch). TransactionTerminatedException is',
    "//     MII's Terminate Transaction: it ends the transaction, its own catch blocks pass it on to the caller.",
    '//   - Mii.IsEmpty(x) is MII\'s empty check (blank, "null" or "---"), Mii.IsTrue(x) its boolean check ("true" or "1").',
    '//   - Improvements must keep the interfaces and the behaviour (sorting, empty checks, returned values) unless a',
    '//     change is asked for; list every behaviour change separately.',
    '//   - The notes below are problems of the MII objects themselves (stale links, undeclared properties); the code',
    '//     keeps them as they are.',
  ];
}

/** The calls of a transaction, recursively; a transaction already shown is not expanded again. */
function callTree(contract, prefix, expanded, lines) {
  expanded.push(contract);

  for (const entry of contract.outline) {
    const flow = entry.flow.length > 0 ? '  [' + entry.flow + ']' : '';
    const action = ' (' + entry.actionName + ')';

    if (entry.kind === 'call' && entry.callee && expanded.includes(entry.callee)) {
      lines.push(prefix + 'call   ' + entry.target + action + flow + '  - shown above');
      continue;
    }

    lines.push(prefix + entry.kind.padEnd(6) + ' ' + entry.target + action + flow);

    if (entry.kind === 'call' && entry.callee) {
      callTree(entry.callee, prefix + '    ', expanded, lines);
    }
  }
}

function sharedPropertyOverview(property) {
  const head = '//   ' + property.name + ' (project ' + property.project + ')';

  if (property.definition === null) {
    return [head + (property.projectLoaded ? ': not defined in SharedProperties.mem' : ': SharedProperties.mem not readable')];
  }

  const settings = property.definition.attributes.filter(([name, value]) => name !== 'Name' && name !== 'Project' && value.length > 0)
    .map(([name, value]) => name + ' = ' + value.replace(/\r\n?|\n/g, ' '));
  const lines = [head + ': ' + settings.join(', ')];
  const value = limitedDefault(property.definition.defaultValue).replace(/\r\n?/g, '\n').split('\n');

  if (value.length === 1) {
    lines.push('//     default: ' + value[0]);
  } else {
    lines.push('//     default:', ...value.map((line) => '//       ' + line));
  }

  return lines;
}

/** A comment line with a line break in an MII text goes on as comment lines, so the file still compiles. */
function commentContinued(line) {
  const match = /^(\s*)(\/\/\/?)/.exec(line);

  if (match === null || !/[\r\n]/.test(line)) {
    return [line];
  }

  const [first, ...rest] = line.split(/\r\n?|\n/);
  return [first, ...rest.map((part) => match[1] + match[2] + '     ' + part)];
}

/** The web files as text constants. */
function filesClass(context) {
  if (context.fileConstants.size === 0) {
    return [];
  }

  const body = [];

  for (const [path, name] of context.fileConstants) {
    if (body.length > 0) {
      body.push('');
    }

    body.push('/// <summary>' + xmlText(path) + '</summary>', 'public const string ' + name + ' = ' + CsLiteral.string(context.graph.files.get(path)) + ';');
  }

  return ['', '/// <summary>The web files the transactions name, as loaded from the MII server.</summary>', 'public static class MiiFiles', '{', ...indent(body), '}'];
}

function queryOverview(contract) {
  const query = contract.query;
  const kind = query.kind === MiiQueryKind.Xacute ? 'Xacute query, runs its transaction'
    : query.kind === MiiQueryKind.Xml ? 'XML query, via IPluginService' : query.rootName + ' ' + query.mode;
  const lines = ['//   ' + query.shortName + ' = ' + query.path + ' (' + kind + ')'];

  if (contract.parameters.length > 0) {
    const mode = contract.parameterMode === 'typed' ? ' (typed: bound as statement parameters)'
      : contract.parameterMode === 'text' ? ' (text: replaced as text)' : '';
    lines.push('//     parameters' + mode + ': ' + contract.parameters.map((p) => '[Param.' + p.slot + '] ' + p.name
      + (contract.parameterMode === 'typed' ? ' ' + (p.type || '(no type)') : '')).join(', '));
  }

  const settings = query.attributes.filter(([name, value]) => value.trim().length > 0 && name !== 'Query' && name !== 'TempTableList' && !/^Param(Description|Type)?\.\d+$/.test(name));
  const defaults = query.attributes.filter(([name, value]) => value.length > 0 && /^Param\.\d+$/.test(name));

  if (settings.length > 0) {
    lines.push('//     settings: ' + settings.map(([name, value]) => name + ' = ' + value.replace(/\r\n?|\n/g, ' ')).join(', '));
  }

  if (defaults.length > 0) {
    lines.push('//     parameter defaults: ' + defaults.map(([name, value]) => '[' + name + '] = ' + limitedDefault(value).replace(/\r\n?|\n/g, ' ')).join(', '));
  }

  if (query.kind === MiiQueryKind.Xml && contract.fileConstant) {
    lines.push('//     URL content: ' + contract.fileConstant);
  }

  lines.push('//     run by: ' + (contract.callers.length > 0 ? contract.callers.join('; ') : '(no action of these transactions)'));

  if (contract.result) {
    const read = contract.result.columns.filter((column) => column.read).map((column) => column.name);
    const unread = contract.result.columns.filter((column) => !column.read).map((column) => column.name);
    lines.push('//     columns read by name: ' + (read.length > 0 ? read.join(', ') : 'none'));

    if (unread.length > 0) {
      lines.push('//     columns not read by name: ' + unread.join(', ')
        + (contract.result.passedOnWhole ? ' (the result is also passed on as a whole, so they may be used further on)' : ''));
    }
  }

  return lines;
}

function records(context) {
  const lines = [];

  for (const transaction of context.graph.transactions) {
    const contract = context.transactions.get(transaction);

    if (contract.resultRecordName === null) {
      continue;
    }

    lines.push('', '/// <summary>The outputs of ' + xmlText(transaction.path) + '.</summary>');
    lines.push('public sealed record ' + contract.resultRecordName + '(');
    contract.outputs.forEach((output, index) => lines.push('    ' + output.type.name + ' ' + output.resultName
      + (index < contract.outputs.length - 1 ? ',' : ');') + ' // Transaction.' + output.miiName + ' (' + (output.miiType || 'no type') + ')'));
  }

  for (const contract of context.contracts) {
    lines.push('', '/// <summary>A row of an MII rowset document (' + xmlText(contract.origin) + ').</summary>');
    lines.push('public sealed record ' + contract.rowClass + ' : MiiRow', '{');
    const body = [];

    for (const column of contract.columns) {
      body.push('public ' + column.type.name + ' ' + column.propertyName + ' { get; set; }' + (column.type.kind === TypeKind.String ? ' = "";' : '')
        + ' // column ' + column.name);
    }

    lines.push(...indent(body), '}');
  }

  return lines;
}
