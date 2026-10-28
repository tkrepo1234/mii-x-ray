// Contracts: method names, parameters, outputs, locals, query parameters and row records of every object, built
// before any code is generated so that callers can refer to their callees' types.
import { MiiXml, MiiQueryKind } from './model.js';
import { ObjectPath } from './sources.js';
import { RowsetContract, ContractFactory, extractSqlColumns, shrinkXmlSample } from './rowset.js';
import { CsType, TypeKind, TypedCode, Naming, UniqueNames, CsLiteral, ValueLiteral } from './types.js';

/** An input (method parameter), an output or a local variable of a transaction method. */
export class PropertySpec {
  constructor(miiName, name, type, description) {
    this.miiName = miiName;
    this.name = name; // camelCase inside the method
    this.resultName = null; // PascalCase property of the result record (several outputs)
    this.type = type;
    this.initializer = null;
    this.description = description;
  }
}

/** One transaction as a method. */
export class TransactionContract {
  constructor(transaction, methodName) {
    this.transaction = transaction;
    this.methodName = methodName;
    this.resultRecordName = null;
    this.inputs = [];
    this.outputs = [];
    this.locals = [];
    this.localNames = new UniqueNames();
    this.outline = []; // calls, queries and plugin actions in execution order (call tree)
  }

  findInput(miiName) {
    return this.inputs.find((p) => p.miiName === miiName) || null;
  }

  findOutput(miiName) {
    return this.outputs.find((p) => p.miiName === miiName) || null;
  }

  findLocal(miiName) {
    return this.locals.find((p) => p.miiName === miiName) || null;
  }

  get returnTypeName() {
    if (this.outputs.length === 0) {
      return 'void';
    }

    return this.outputs.length === 1 ? this.outputs[0].type.name : this.resultRecordName;
  }

  get returnType() {
    if (this.outputs.length === 0) {
      return null;
    }

    return this.outputs.length === 1 ? this.outputs[0].type : CsType.class(this.resultRecordName);
  }

  get returnStatement() {
    if (this.outputs.length === 0) {
      return 'return;';
    }

    if (this.outputs.length === 1) {
      return 'return ' + this.outputs[0].name + ';';
    }

    return 'return new ' + this.resultRecordName + '(' + this.outputs.map((o) => o.name).join(', ') + ');';
  }

  /** An output of this transaction, read from the variable that holds what a call returned. */
  outputOf(variable, miiName) {
    const output = this.findOutput(miiName);

    if (!output) {
      return null;
    }

    return this.outputs.length === 1 ? TypedCode.primary(variable, output.type) : TypedCode.primary(variable + '.' + output.resultName, output.type);
  }
}

/** One query template: its local variable name, parameters and result rows. */
export class QueryContract {
  constructor(query) {
    this.query = query;
    this.variableName = Naming.camel(query.shortName);
    this.parameters = []; // { slot, name }
    this.result = null;
    this.xacuteTarget = null;
    this.callers = [];
  }

  findParameter(slot) {
    return this.parameters.find((p) => p.slot === slot) || null;
  }
}

const RUNTIME_TYPE_NAMES = ['Mii', 'MiiRow', 'MiiRows', 'Query', 'IQueryService', 'IPluginService', 'PluginResult', 'MiiException', 'TransactionTerminatedException'];

/** Shared state of one generation run. */
export class GenerationContext {
  constructor(graph) {
    this.graph = graph;
    this.transactions = new Map();
    this.queries = new Map();
    this.typeNames = new UniqueNames();
    this.methodNames = new UniqueNames();
    this.contracts = [];
    this.notes = [];
    this.className = null;
    RUNTIME_TYPE_NAMES.forEach((name) => this.typeNames.reserve(name));
  }

  note(where, message) {
    const note = where + ': ' + message;

    if (!this.notes.includes(note)) {
      this.notes.push(note);
    }
  }

  findTransaction(reference) {
    const transaction = this.graph.findTransaction(reference);
    return transaction ? this.transactions.get(transaction) || null : null;
  }

  findQuery(reference) {
    const query = this.graph.findQuery(reference);
    return query ? this.queries.get(query) || null : null;
  }

  createContract(baseName, origin) {
    const contract = new RowsetContract(this.typeNames.claim(Naming.pascal(baseName).replace(/^@/, '') + 'Row'), origin);
    this.contracts.push(contract);
    return contract;
  }

  /** An existing row record with the same columns (dropping the new one), or the new one. */
  shareIdentical(contract) {
    if (contract.columns.length === 0) {
      return contract;
    }

    const existing = this.contracts.find((other) => other !== contract && other.signature === contract.signature);

    if (existing) {
      this.contracts.splice(this.contracts.indexOf(contract), 1);
      return existing;
    }

    return contract;
  }
}

export const ContractBuilder = {
  build(context) {
    const baseName = context.graph.folder !== null ? ObjectPath.leaf(context.graph.folder) : context.graph.root.shortName;
    context.className = context.typeNames.claim(Naming.pascal(baseName).replace(/^@/, '') + 'Logic');

    for (const transaction of context.graph.transactions) {
      context.transactions.set(transaction, new TransactionContract(transaction, claimName(context.methodNames, transaction.path)));
    }

    for (const query of context.graph.queries) {
      context.queries.set(query, new QueryContract(query));
    }

    for (const contract of context.transactions.values()) {
      buildInterface(context, contract);
    }

    for (const contract of context.queries.values()) {
      buildQuery(context, contract);
    }

    addCachedQueryColumns(context);
  },

  /** The empty value of a type (MII default values are not carried over). */
  emptyValue(type) {
    switch (type.kind) {
      case TypeKind.String: return '""';
      case TypeKind.Bool: return 'false';
      case TypeKind.Int: return '0';
      case TypeKind.Long: return '0L';
      case TypeKind.Double: return '0.0';
      case TypeKind.Decimal: return '0m';
      case TypeKind.DateTime: return 'DateTime.MinValue';
      case TypeKind.List:
      case TypeKind.Rowset: return '[]';
      case TypeKind.Map:
      case TypeKind.Xml:
      case TypeKind.Row: return 'new()';
      default: return 'null';
    }
  },

  /** A configured MII value as C# code of the given type. */
  initializer(type, defaultText) {
    switch (type.kind) {
      case TypeKind.String: return CsLiteral.string(defaultText || '');
      case TypeKind.Bool: return CsLiteral.isTrue(defaultText) ? 'true' : 'false';
      case TypeKind.Int:
      case TypeKind.Long:
      case TypeKind.Double:
      case TypeKind.Decimal: return CsLiteral.number(defaultText, type.kind);
      case TypeKind.DateTime: return CsLiteral.dateTimeValue(defaultText);
      case TypeKind.List: return ValueLiteral.listCode(defaultText);
      case TypeKind.Map: return ValueLiteral.mapCode(defaultText);
      case TypeKind.Rowset: return 'new ' + type.name + '()';
      case TypeKind.Xml:
        return MiiXml.tryParse(defaultText) ? 'Mii.ParseXml(' + CsLiteral.string(defaultText.trim()) + ')' : 'new XmlDocument()';
      default: return 'null';
    }
  },
};

function claimName(names, path) {
  let name = Naming.pascal(ObjectPath.leaf(path)).replace(/^@/, '');

  if (names.isUsed(name)) {
    const folder = ObjectPath.leaf(ObjectPath.folder(path));

    if (folder.length > 0) {
      name = Naming.pascal(folder).replace(/^@/, '') + name;
    }
  }

  return names.claim(name);
}

function buildInterface(context, contract) {
  const transaction = contract.transaction;
  ['queries', 'plugins'].forEach((name) => contract.localNames.reserve(name));

  for (const parameter of transaction.inputs) {
    const input = property(context, contract, parameter);
    input.initializer = 'default';
    contract.inputs.push(input);
  }

  const resultNames = new UniqueNames();

  for (const parameter of transaction.outputs) {
    const output = property(context, contract, parameter);
    output.resultName = resultNames.claim(Naming.pascal(parameter.name).replace(/^@/, ''));
    output.initializer = ContractBuilder.emptyValue(output.type);
    contract.outputs.push(output);
  }

  if (contract.outputs.length > 1) {
    contract.resultRecordName = context.typeNames.claim(contract.methodName + 'Result');
  }

  const written = writtenLocals(transaction);

  for (const parameter of transaction.locals) {
    const local = property(context, contract, parameter);
    // a local the flow never replaces as a whole is configuration or a template: it keeps its MII value
    const configuration = !written.has(parameter.name) && local.type.kind !== TypeKind.Rowset && parameter.defaultText.trim().length > 0;
    local.initializer = configuration
      ? ContractBuilder.initializer(local.type, local.type.kind === TypeKind.Xml ? shrinkXmlSample(parameter.defaultText) : parameter.defaultText)
      : ContractBuilder.emptyValue(local.type);
    contract.locals.push(local);
  }
}

/** Locals the flow replaces as a whole. A local only edited at an XPath (SetXPathValue, AppendXml, RemoveXml...) is a
 * template: it keeps its MII value, otherwise the edits would work on an empty document. */
function writtenLocals(transaction) {
  const written = new Set();

  for (const use of transaction.allActionUses()) {
    for (const link of use.outgoing) {
      if (link.to.startsWith('Local.')) {
        const name = link.to.substring('Local.'.length);
        const brace = name.indexOf('{');
        const selector = brace >= 0 ? name.substring(brace + 1, Math.max(name.lastIndexOf('}'), brace + 1)).trim() : '';

        if (selector.length === 0 && WHOLE_WRITES.includes(link.kind)) {
          written.add(brace >= 0 ? name.substring(0, brace) : name);
        }
      }
    }
  }

  return written;
}

const WHOLE_WRITES = ['Assign', 'AssignXml', 'ReplaceXml'];

function property(context, contract, parameter) {
  return new PropertySpec(parameter.name, contract.localNames.claim(Naming.camel(parameter.name)), typeOf(context, contract, parameter), parameter.description);
}

function typeOf(context, contract, parameter) {
  switch (parameter.type) {
    case 'boolean': return CsType.Bool;
    case 'integer':
    case 'short':
    case 'byte': return CsType.Int;
    case 'long': return CsType.Long;
    case 'double':
    case 'float': return CsType.Double;
    case 'dateTime': return CsType.DateTime;
    case 'list': return CsType.List;
    case 'map': return CsType.Map;
    case 'xml':
    case 'resultSet': return xmlTypeOf(context, contract, parameter);
    default: return CsType.String;
  }
}

/** An xml property is typed by its reference document when that is an Illuminator rowset. */
function xmlTypeOf(context, contract, parameter) {
  let text = parameter.defaultText;

  if (text.trim().length === 0 && parameter.referenceSource.startsWith('Local.')) {
    const localName = parameter.referenceSource.substring('Local.'.length);

    for (const local of contract.transaction.locals) {
      if (local.name === localName) {
        text = local.defaultText;
      }
    }
  }

  const document = MiiXml.tryParse(text);

  if (!document || !document.documentElement || document.documentElement.localName !== 'Rowsets') {
    return CsType.Xml;
  }

  const rowset = context.createContract(parameter.name, 'reference document of ' + parameter.name + ' in ' + contract.transaction.path);
  ContractFactory.addColumnsFromRowsets(rowset, document);
  return CsType.rowsetOf(context.shareIdentical(rowset));
}

function buildQuery(context, contract) {
  const query = contract.query;
  const names = new UniqueNames();

  for (const parameter of query.parameters) {
    let baseName = parameter.description.length > 0 ? parameter.description : 'Param' + parameter.slot;

    if (query.kind === MiiQueryKind.Xacute && query.xacuteMappedTargets.has(parameter.slot)) {
      baseName = query.xacuteMappedTargets.get(parameter.slot);
    }

    contract.parameters.push({ slot: parameter.slot, name: names.claim(baseName) });
  }

  if (query.kind === MiiQueryKind.Sql || query.kind === MiiQueryKind.Mdo) {
    contract.result = context.createContract(query.shortName, 'columns of ' + query.path);

    for (const column of query.kind === MiiQueryKind.Sql ? extractSqlColumns(query.text) : mdoAttributes(query.text)) {
      contract.result.add(column, CsType.String, true);
    }
  }

  if (query.kind === MiiQueryKind.Xacute) {
    contract.xacuteTarget = context.findTransaction(query.xacuteTransaction);
  }
}

function mdoAttributes(text) {
  const select = text.indexOf('SELECT ');
  const from = text.indexOf(' FROM ');

  if (select < 0 || from < select) {
    return [];
  }

  return text.substring(select + 7, from).split(',').map((part) => part.trim().replace(/^\[+|\]+$/g, '').trim()).filter((name) => name.length > 0 && name !== '*');
}

/** Query actions keep the result of the developer's last test run (Results): the exact result contract with SQL types. */
function addCachedQueryColumns(context) {
  for (const transaction of context.graph.transactions) {
    for (const action of transaction.actions.values()) {
      if (!action.hasProperty('QueryTemplate')) {
        continue;
      }

      const query = context.findQuery(action.static('QueryTemplate'));

      if (query && query.result) {
        ContractFactory.addColumnsFromRowsets(query.result, MiiXml.tryParse(MiiXml.ownText(action.property('Results'))));
      }
    }
  }
}
