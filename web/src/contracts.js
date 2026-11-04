// Contracts: method names, parameters, outputs, locals, query parameters and row records of every object, built
// before any code is generated so that callers can refer to their callees' types.
import { MiiXml, MiiQueryKind } from './model.js';
import { ObjectPath } from './sources.js';
import { RowsetContract, ContractFactory, extractSqlColumns } from './rowset.js';
import { CsType, TypeKind, TypedCode, Naming, UniqueNames, CsLiteral, ValueLiteral, limitedDefault, isOmittedDefault } from './types.js';

/** An input (method parameter), an output or a local variable of a transaction method. */
export class PropertySpec {
  constructor(miiName, name, type, description) {
    this.miiName = miiName;
    this.name = name; // camelCase inside the method
    this.resultName = null; // PascalCase property of the result record (several outputs)
    this.type = type;
    this.initializer = null;
    this.description = description;
    this.miiType = ''; // the MII data type (string, int, xml, list, map, ...)
    this.defaultText = ''; // the MII default value as stored ("[n-bytes]" when larger than DEFAULT_LIMIT)
    this.defaultInCode = false; // the code already holds the full default value
    this.defaultStatement = null; // an input default C# cannot write as a parameter default: set at the method start
    this.replaced = false; // a local the flow replaces as a whole (it may be declared where it is set)
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
    this.parameters = []; // { slot, name, type }
    // how [Param.N] gets its value: 'typed' (bound, UseTypedParams), 'text' (replaced as text) or null (other kinds)
    this.parameterMode = query.kind === MiiQueryKind.Sql || query.kind === MiiQueryKind.Mdo ? (query.typedParameters ? 'typed' : 'text') : null;
    this.result = null;
    this.xacuteTarget = null;
    this.callers = [];
  }

  findParameter(slot) {
    return this.parameters.find((p) => p.slot === slot) || null;
  }

  /** The comment above the parameters: how [Param.N] gets its value and which name (and type) each slot has. */
  parameterComment() {
    const slots = this.parameters.map((p) => '[Param.' + p.slot + '] = ' + p.name + (this.parameterMode === 'typed' ? ' ' + (p.type || '(no type)') : ''));

    if (this.parameterMode === 'typed') {
      return '// typed parameters (bound as statement parameters, no quoting): ' + slots.join(', ');
    }

    return this.parameterMode === 'text' ? '// text parameters (replaced as text, callers quote and escape): ' + slots.join(', ') : '// ' + slots.join(', ');
  }

  /** The statement that sets one parameter: AddTypedParameter for a bound one, AddParameter for text. */
  addParameterCode(variable, parameter, value) {
    return this.parameterMode === 'typed'
      ? variable + '.AddTypedParameter(' + CsLiteral.string(parameter.name) + ', ' + CsLiteral.string(parameter.type || '') + ', ' + value + ');'
      : variable + '.AddParameter(' + CsLiteral.string(parameter.name) + ', ' + value + ');';
  }
}

const RUNTIME_TYPE_NAMES = ['MiiFiles', 'Mii','MiiRow', 'MiiRows', 'MiiRowList', 'IMiiDocument', 'Query', 'IQueryService', 'IPluginService', 'PluginResult', 'MiiException', 'TransactionTerminatedException'];

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
    this.fileConstants = new Map(); // Catalog path of a loaded web file -> constant name in MiiFiles
    this._fileNames = new UniqueNames();
    RUNTIME_TYPE_NAMES.forEach((name) => this.typeNames.reserve(name));
  }

  /** The constant (MiiFiles.Name) with the content of a loaded web file; null when the path is null or the file was
   * not loaded. */
  fileConstant(path) {
    if (path === null || !this.graph.files || typeof this.graph.files.get(path) !== 'string') {
      return null;
    }

    if (!this.fileConstants.has(path)) {
      this.fileConstants.set(path, this._fileNames.claim(Naming.pascal(ObjectPath.leaf(path).replace(/\./g, '_')).replace(/^@/, '')));
    }

    return 'MiiFiles.' + this.fileConstants.get(path);
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

  /** The MII default of a property as C# code: the code, and whether it holds the whole default (else the
   * declaration comment shows it). A default left out of the file ("[n-bytes]") stays a text only for a string. */
  defaultValue(type, defaultText) {
    const text = defaultText || '';
    const empty = ContractBuilder.emptyValue(type);

    if (type.kind !== TypeKind.String && text.trim().length === 0) {
      return { code: empty, exact: true };
    }

    if (type.kind !== TypeKind.String && isOmittedDefault(text)) {
      return { code: empty, exact: false };
    }

    switch (type.kind) {
      case TypeKind.String:
      case TypeKind.Bool:
      case TypeKind.List:
      case TypeKind.Map:
        return { code: ContractBuilder.initializer(type, text), exact: true };
      case TypeKind.Int:
      case TypeKind.Long:
      case TypeKind.Double:
      case TypeKind.Decimal:
        return { code: CsLiteral.number(text, type.kind), exact: /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text.trim()) };
      case TypeKind.DateTime: {
        const code = CsLiteral.dateTimeValue(text);
        return { code, exact: code !== 'DateTime.MinValue' };
      }
      case TypeKind.Xml:
      case TypeKind.Rowset:
        return MiiXml.tryParse(text) ? { code: ContractBuilder.initializer(type, text), exact: true } : { code: empty, exact: false };
      default:
        return { code: empty, exact: false };
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
      case TypeKind.Rowset:
        return MiiXml.tryParse(defaultText)
          ? 'Mii.ToRows<' + type.contract.rowTypeName + '>(Mii.ParseXml(' + CsLiteral.string(defaultText.trim()) + '))'
          : 'new ' + type.name + '()';
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
    const value = ContractBuilder.defaultValue(input.type, input.defaultText);

    if (PARAMETER_DEFAULTS.includes(input.type.kind)) {
      // a constant: the parameter default, which C# takes when a caller does not link the input (as MII does)
      input.initializer = value.code;
      input.defaultInCode = value.exact;
    } else {
      input.initializer = 'default';

      if (value.code !== ContractBuilder.emptyValue(input.type)) {
        input.defaultStatement = input.type.kind === TypeKind.DateTime
          ? ['if (' + input.name + ' == default)', '{', '    ' + input.name + ' = ' + value.code + ';', '}']
          : [input.name + ' ??= ' + value.code + ';'];
        input.defaultInCode = value.exact;
      }
    }

    contract.inputs.push(input);
  }

  const resultNames = new UniqueNames();

  for (const parameter of transaction.outputs) {
    const output = property(context, contract, parameter);
    output.resultName = resultNames.claim(Naming.pascal(parameter.name).replace(/^@/, ''));
    const value = ContractBuilder.defaultValue(output.type, output.defaultText);
    output.initializer = value.code;
    output.defaultInCode = value.exact;
    contract.outputs.push(output);
  }

  if (contract.outputs.length > 1) {
    contract.resultRecordName = context.typeNames.claim(contract.methodName + 'Result');
  }

  const written = writtenLocals(transaction);

  for (const parameter of transaction.locals) {
    // every local starts with its MII default; one the flow replaces as a whole may be declared where it is set
    const local = property(context, contract, parameter);
    const value = ContractBuilder.defaultValue(local.type, local.defaultText);
    local.initializer = value.code;
    local.defaultInCode = value.exact;
    local.replaced = written.has(parameter.name) || value.code === ContractBuilder.emptyValue(local.type);
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

/** Input types whose default C# writes as a parameter default (a constant). */
const PARAMETER_DEFAULTS = [TypeKind.String, TypeKind.Bool, TypeKind.Int, TypeKind.Long, TypeKind.Double, TypeKind.Decimal];

function property(context, contract, parameter) {
  const spec = new PropertySpec(parameter.name, contract.localNames.claim(Naming.camel(parameter.name)), typeOf(context, contract, parameter), parameter.description);
  spec.miiType = parameter.type;
  spec.defaultText = limitedDefault(parameter.defaultText);
  return spec;
}

/** The comment at a declaration: exact MII name and type, and the MII default value unless the code already
 * initializes with it (a multi-line value follows on lines of its own). */
export function declarationComment(prefix, spec, withDefault = !spec.defaultInCode) {
  const head = prefix + spec.miiName + ' (' + (spec.miiType || 'no type') + ')';
  const value = withDefault ? spec.defaultText || '' : '';

  if (value.trim().length === 0) {
    return [head];
  }

  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  return lines.length === 1 ? [head + ', default: ' + lines[0]] : [head + ', default:'].concat(lines.map((line) => '  ' + line));
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

    contract.parameters.push({ slot: parameter.slot, name: names.claim(baseName), type: parameter.type });
  }

  if (contract.parameterMode === 'typed') {
    const quoted = [...new Set([...query.text.matchAll(/'\[Param\.(\d+)\]'/g)].map((match) => '[Param.' + match[1] + ']'))];

    if (quoted.length > 0) {
      context.note(query.path, 'typed parameters, but ' + quoted.join(', ') + ' stand in quotes: a bound parameter inside quotes is no parameter '
        + '(the placeholder stays literal text; unverified on MII)');
    }
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
