// The generated file (C# 12): header, the logic class with one method per transaction, the records (results and
// rows), the service interfaces and the runtime.
import { MiiQueryKind } from './model.js';
import { GenerationContext, ContractBuilder } from './contracts.js';
import { TransactionEmitter, indent } from './emitter.js';
import { addBlankLines } from './placer.js';
import { TypeKind } from './types.js';

export const TOOL_VERSION = '2.1.0';

const xmlText = (text) => (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Generates the file. runtimeText is the C# source of the runtime (RuntimeSource.txt), now the generation time. */
export function generateCode(graph, sourceDescription, runtimeText, now) {
  const context = new GenerationContext(graph);
  ContractBuilder.build(context);

  // methods first: they complete the row records (columns read by XPath)
  const methods = [];

  for (const transaction of graph.transactions) {
    const contract = context.transactions.get(transaction);
    methods.push('', ...new TransactionEmitter(context, contract).emitMethod(transaction === graph.root));
  }

  const root = context.transactions.get(graph.root);
  const lines = [
    ...header(context, root, sourceDescription, now),
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
    'namespace XRay.' + root.methodName + ';',
    '',
    '/// <summary>',
    '/// The logic of ' + xmlText(root.transaction.path) + ' and of every transaction it calls, one method each.',
    '/// </summary>',
    'public sealed class ' + context.className + '(IQueryService queries, IPluginService plugins)',
    '{',
    ...indent(methods.slice(1)),
    '}',
    ...records(context),
    '',
    ...runtimeText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd().split('\n'),
  ];

  const code = addBlankLines(lines).join('\n').replace(/\r\n/g, '\n');
  return {
    code: code.replace(/\n/g, '\r\n') + '\r\n',
    rootName: root.methodName,
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
    '// code does, not how MII runs it: MII runtime settings and default values are left out, a called transaction is a',
    '// method, a query goes through IQueryService, an MII action without a C# equivalent through IPluginService.',
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
  lines.push('// Call tree (execution order; [if X], [else X], [case n of X], [loop X] = once per item, [on error X] = in the handler of the catch X):');
  lines.push('//   ' + root.methodName);
  callTree(root, '//     ', [], lines);

  if (context.graph.queries.length > 0) {
    lines.push('//', '// Queries (' + context.graph.queries.length + '):');

    for (const query of context.graph.queries) {
      lines.push(...queryOverview(context.queries.get(query)));
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

function readingRules() {
  return [
    '// How to read this file:',
    '//   - Every MII transaction is a method: its parameters are the MII inputs, its return value the MII outputs (a',
    '//     record when there are several). A caller passes the inputs it links; MII default values are not carried over.',
    '//   - A query is a local Query variable: its text is the MII template text, AddParameter(name, value) sets a parameter;',
    '//     the comment above it maps [Param.N] to the names. MII replaces [Param.N] by the value as text, there are no',
    '//     bind variables; quoting and escaping are done by the callers (e.g. Mii.StringReplace(x, "\'", "\'\'")).',
    '//   - MII rowset documents are lists of row records; FirstOrEmpty() and RowAt(n) give an empty row instead of null.',
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

function queryOverview(contract) {
  const query = contract.query;
  const kind = query.kind === MiiQueryKind.Xacute ? 'Xacute query, runs its transaction'
    : query.kind === MiiQueryKind.Xml ? 'XML query, via IPluginService' : query.rootName + ' ' + query.mode;
  const lines = ['//   ' + query.shortName + ' = ' + query.path + ' (' + kind + ')'];

  if (contract.parameters.length > 0) {
    lines.push('//     parameters: ' + contract.parameters.map((p) => '[Param.' + p.slot + '] ' + p.name).join(', '));
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
    lines.push('public sealed record ' + contract.resultRecordName + '(' + contract.outputs.map((o) => o.type.name + ' ' + o.resultName).join(', ') + ');');
  }

  for (const contract of context.contracts) {
    lines.push('', '/// <summary>A row of an MII rowset document (' + xmlText(contract.origin) + ').</summary>');
    lines.push('public sealed record ' + contract.rowClass + ' : MiiRow', '{');
    const body = [];

    for (const column of contract.columns) {
      if (column.propertyName !== column.name) {
        body.push('/// <summary>Column ' + xmlText(column.name) + '.</summary>');
      }

      body.push('public ' + column.type.name + ' ' + column.propertyName + ' { get; set; }' + (column.type.kind === TypeKind.String ? ' = "";' : ''));
    }

    lines.push(...indent(body), '}');
  }

  return lines;
}
