// The method of one transaction: the step tree becomes C# control flow, the actions become calls, the links become
// assignments.
// Execution model: a step runs its action, then its children in order. Conditional: child 0 = true path, child 1 =
// false path, further children run afterwards. Switcher: one child per match value, then the default, further
// children afterwards. Loops: child 0 is the body, further children run once after the loop. Catch: handles whatever
// ran before it in the same parent (and the parent's own action) - a try block around those statements.
import { MiiXml, MiiQueryKind } from './model.js';
import { literalLinkedValue, linkedExpression } from './resolver.js';
import { parseExpression, ExpressionError, referenceScope, referenceMember } from './expressions.js';
import { ContractFactory } from './rowset.js';
import { ContractBuilder } from './contracts.js';
import { ExpressionTranslator, convertTo, toStringCode } from './translator.js';
import { CsType, TypeKind, TypedCode, Precedence, Naming, CsLiteral } from './types.js';
import { placeDeclarations, withMiiName } from './placer.js';

const ActionKind = {
  None: 'None', TransactionCall: 'TransactionCall', Query: 'Query', QueryCommand: 'QueryCommand', Xacute: 'Xacute',
  Plugin: 'Plugin', Catch: 'Catch', Document: 'Document', Xml: 'Xml', Loop: 'Loop',
};

const LOOP_TYPES = ['IteratorAction', 'RepeaterAction', 'ForNextRepeaterAction', 'WhileRepeaterAction'];
const SHARED_SCOPES = ['Inline', 'Persistent', 'Global', 'Shared'];
const TERMINATION_MARKER = 'new TransactionTerminatedException(';
const PARAM_SLOT = /^Param\.(\d+)$/;
const SECRET = /password|passwort|secret|^pin$/i;
const SINGLE_ROW_COLUMN_PATH = /^\/?Row\/([A-Za-z_][A-Za-z0-9_]*)$/;
const WORD = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Settings of a transaction call that only steer the MII runtime. */
const CALL_SETTINGS = ['TransactionName', 'ResetState', 'Persist', 'Async', 'LogLevel', 'LogType', 'StoreTransactionOutput', 'Expiration', 'Inputs', 'Outputs'];

/** Query action settings that only steer the MII runtime. */
const QUERY_SETTINGS = [
  'QueryTemplate', 'Server', 'RowCount', 'DateFormat', 'NumberFormat', 'XmlDateFormat', 'XmlNumberFormat', 'AutoCommit',
  'Timeout', 'Format', 'SQLTransaction', 'Results', 'ResultsAsString', 'ResultSet', 'TagList', 'QueryStartDate', 'QueryEndDate',
  'QueryParameters', 'Mode', 'InlineTransform',
];

/** Properties that hold the last design-time run (caches) or editor state, never configuration. */
const NOISE_PROPERTIES = [
  'Results', 'ResultsAsString', 'ResultSet', 'TagList', 'QueryStartDate', 'QueryEndDate', 'StartDate', 'EndDate', 'Output',
  'Response', 'Item', 'Expiration', 'LastErrorMessage', 'ItemCount', 'CurrentItem', 'Break', 'InputCount', 'LogicalAnd',
  'XmlContent', 'document', 'QueryParameters', 'SQLTransaction', 'Request', 'Success', 'TextOutput', 'Existed', 'Valid', 'Messages',
];

const TRIVIAL_VALUES = ['', 'INHERIT', 'false', '0', '-1', '-9223372036854775808', 'NEVER', 'Never'];

/** Every physical line indented, so raw string literals (closing quotes at the start of a line) keep their value. */
export function indent(lines) {
  return lines.map((line) => (line.length === 0 ? line : '    ' + line.replace(/\r\n/g, '\n').replace(/\n/g, '\n    ')));
}

const hasCode = (lines) => lines.some((line) => {
  const trimmed = line.trim();
  return trimmed.length > 0 && !trimmed.startsWith('//');
});

const xmlText = (text) => (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function oneLine(text) {
  const value = (text || '').replace(/\s+/g, ' ').trim();
  return value.length > 100 ? value.substring(0, 100) + '...' : value;
}

function parseCount(text, fallback) {
  return /^\s*[+-]?\d+\s*$/.test(text) ? parseInt(text, 10) : fallback;
}

/** A link target: "Transaction.X{/a/b}" -> path "Transaction.X", selector "/a/b", property "X". */
function linkTarget(to) {
  const text = (to || '').trim();
  const brace = text.indexOf('{');
  let path = text;
  let selector = null;

  if (brace >= 0) {
    path = text.substring(0, brace);
    selector = text.substring(brace + 1);

    if (selector.endsWith('}')) {
      selector = selector.substring(0, selector.length - 1);
    }

    selector = selector.trim();
  }

  const dot = path.indexOf('.');
  return { path, selector, property: dot >= 0 ? path.substring(dot + 1) : path };
}

export class TransactionEmitter {
  constructor(context, contract) {
    this._context = context;
    this._contract = contract;
    this._transaction = contract.transaction;
    this._translator = new ExpressionTranslator(this);
    this._names = contract.localNames;
    this._actions = new Map();
    this._loops = [];
    this._flow = [];
    this._expressionTexts = [];
    this._currentAction = '';
    this._collectExpressionTexts();

    for (const definition of this._transaction.actions.values()) {
      this._actions.set(definition.name, this._createSymbol(definition));
    }
  }

  // ---------------------------------------------------------------------------------------------- symbols

  _collectExpressionTexts() {
    for (const use of this._transaction.allActionUses()) {
      for (const link of use.incoming.concat(use.outgoing)) {
        this._expressionTexts.push(link.from, link.to);
      }
    }

    for (const definition of this._transaction.actions.values()) {
      for (const property of ['Source', 'IlluminatorDocument', 'From', 'To', 'Step']) {
        if (definition.hasProperty(property)) {
          this._expressionTexts.push(definition.static(property));
        }
      }
    }
  }

  _isReferenced(actionName, member) {
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp('(?<![A-Za-z0-9_.])' + escape(actionName) + '\\.' + (member === null ? '' : escape(member) + '(?![A-Za-z0-9_])'));
    return this._expressionTexts.some((text) => text != null && pattern.test(text));
  }

  _isLinkTarget(actionName, member) {
    for (const use of this._transaction.allActionUses()) {
      if (use.outgoing.some((link) => link.to === actionName + '.' + member)) {
        return true;
      }

      if (use.incoming.some((link) => link.to === actionName + '.' + member && use.name !== actionName)) {
        return true;
      }
    }

    return false;
  }

  _createSymbol(definition) {
    const symbol = { name: definition.name, definition, kind: null, variable: null, variableType: null, initializer: null, callee: null, query: null, document: null };
    symbol.kind = this._kindOf(definition, symbol);
    const hasResult = symbol.kind !== ActionKind.None && symbol.kind !== ActionKind.Loop && symbol.kind !== ActionKind.QueryCommand;

    if (!hasResult || !this._isReferenced(definition.name, null)) {
      return symbol;
    }

    symbol.variable = this._names.claim(Naming.camel(definition.name));

    switch (symbol.kind) {
      case ActionKind.TransactionCall:
      case ActionKind.Xacute:
        if (symbol.callee.returnType === null) {
          symbol.variable = null; // the called transaction has no outputs: nothing to keep
          return symbol;
        }

        symbol.variableType = symbol.callee.returnType;
        symbol.initializer = symbol.callee.outputs.length === 1 ? ContractBuilder.emptyValue(symbol.variableType) : 'null';
        break;
      case ActionKind.Query:
        symbol.variableType = CsType.rowsetOf(symbol.query.result);
        symbol.initializer = '[]';
        break;
      case ActionKind.Catch:
        symbol.variableType = CsType.class('Exception');
        symbol.initializer = 'null';
        break;
      case ActionKind.Document:
        symbol.variableType = CsType.rowsetOf(symbol.document);
        symbol.initializer = '[]';
        break;
      case ActionKind.Xml:
        symbol.variableType = CsType.Xml;
        symbol.initializer = 'new()';
        break;
      default:
        symbol.variableType = CsType.class('PluginResult');
        symbol.initializer = 'new()';
        break;
    }

    return symbol;
  }

  _kindOf(definition, symbol) {
    const type = definition.actionType;

    if (LOOP_TYPES.includes(type)) {
      return ActionKind.Loop;
    }

    switch (type) {
      case 'Assignment':
      case 'ConditionalAction':
      case 'SwitcherAction':
      case 'Throw':
      case 'TerminateTransaction':
      case 'Tracer':
      case 'EventLogger':
      case 'Pause':
      case 'IlluminatorRow':
        return ActionKind.None;
      case 'CatchAction':
        return ActionKind.Catch;
      case 'StringToXmlConverter':
      case 'XSLTransform':
        return ActionKind.Xml;
      case 'IlluminatorDocument':
        symbol.document = this._documentContract(definition);
        return ActionKind.Document;
      case 'TransactionCall': {
        // a link to TransactionName decides the callee at runtime; the configured one is then only its interface
        const linked = linkedExpression(this._transaction, definition.name, 'TransactionName');
        const literal = linked === null ? null : literalLinkedValue(this._transaction, definition.name, 'TransactionName');

        if (linked !== null && literal === null) {
          this._currentAction = definition.name;
          this.note('the called transaction is chosen at runtime (TransactionName = ' + oneLine(linked) + '); '
            + definition.static('TransactionName') + ' is only its interface');
          this._currentAction = '';
          return ActionKind.Plugin;
        }

        symbol.callee = this._context.findTransaction(literal !== null ? literal : definition.static('TransactionName'));
        return symbol.callee ? ActionKind.TransactionCall : ActionKind.Plugin;
      }
      case 'DynamicTransactionCall': {
        const literal = literalLinkedValue(this._transaction, definition.name, 'TransactionName');
        symbol.callee = literal === null ? null : this._context.findTransaction(literal);
        return symbol.callee ? ActionKind.TransactionCall : ActionKind.Plugin;
      }
      default:
        break;
    }

    if (definition.hasProperty('QueryTemplate')) {
      let template = definition.static('QueryTemplate');

      if (template.length === 0) {
        template = literalLinkedValue(this._transaction, definition.name, 'QueryTemplate') || '';
      }

      symbol.query = this._context.findQuery(template);

      if (!symbol.query) {
        return ActionKind.Plugin;
      }

      if (symbol.query.query.kind === MiiQueryKind.Xacute) {
        symbol.callee = symbol.query.xacuteTarget;
        return symbol.callee ? ActionKind.Xacute : ActionKind.Plugin;
      }

      if (!symbol.query.result) {
        return ActionKind.Plugin;
      }

      return symbol.query.query.mode.toLowerCase() === 'command' ? ActionKind.QueryCommand : ActionKind.Query;
    }

    return ActionKind.Plugin;
  }

  _documentContract(definition) {
    const contract = this._context.createContract(definition.name, 'column specification of ' + definition.name + ' in ' + this._transaction.path);

    for (const column of MiiXml.children(definition.property('ColumnSpecifications'), 'ContextItem')) {
      const name = MiiXml.childText(column, 'Name').trim();

      if (name.length > 0) {
        contract.add(name, ContractFactory.typeOfColumnSpecification(MiiXml.ownText(MiiXml.child(column, 'Value'))), false);
      }
    }

    return this._context.shareIdentical(contract);
  }

  // ---------------------------------------------------------------------------------------------- symbol resolver

  get transactionPath() {
    return this._transaction.path;
  }

  newName(wanted) {
    return this._names.claim(wanted);
  }

  note(message) {
    this._context.note(this._transaction.shortName + (this._currentAction.length > 0 ? '/' + this._currentAction : ''), message);
  }

  resolve(reference) {
    const scope = referenceScope(reference);
    const member = referenceMember(reference);

    if (scope === 'Transaction') {
      const input = this._contract.findInput(member);

      if (input) {
        return TypedCode.primary(input.name, input.type);
      }

      const output = this._contract.findOutput(member);
      return output ? TypedCode.primary(output.name, output.type) : null;
    }

    if (scope === 'Local') {
      const local = this._contract.findLocal(member);
      return local ? TypedCode.primary(local.name, local.type) : null;
    }

    if (SHARED_SCOPES.includes(scope)) {
      return TypedCode.primary('plugins.GetProperty(' + CsLiteral.string(reference.path) + ')', CsType.Object);
    }

    const loop = this._findLoop(scope);

    if (loop) {
      if (loop.actionType === 'IteratorAction' && member === 'Item') {
        this.note(reference.path + ': an Iterator has no Item in MII ("Invalid variable"); its element is CurrentItem');
        return this._translator.unresolved(reference.path);
      }

      return resolveLoopMember(loop, member);
    }

    const symbol = this._actions.get(scope);

    if (!symbol) {
      return null;
    }

    if (symbol.kind === ActionKind.Loop) {
      this.note(reference.path + ' is used outside its loop');
      return this._translator.unresolved(reference.path);
    }

    const result = resolveActionMember(symbol, member) || configuredValue(symbol, member);

    if (!result) {
      this.note('the action output ' + reference.path + ' has no C# equivalent');
      return this._translator.unresolved(reference.path);
    }

    return result;
  }

  _findLoop(actionName) {
    for (let index = this._loops.length - 1; index >= 0; index--) {
      if (this._loops[index].actionName === actionName) {
        return this._loops[index];
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------------------------- method

  /** The lines of the transaction's method: inputs are parameters, outputs the return value. */
  emitMethod(isPublic) {
    if (/^\s*(false|0)\s*$/i.test(this._transaction.throwOnLinkError)) {
      this._context.note(this._transaction.shortName, 'ThrowOnLinkError is off: in MII a link that fails leaves its target unchanged and the run goes on (the C# throws)');
    }

    const flow = this._emitSiblings(this._transaction.steps, []);
    const lines = ['/// <summary>', '/// ' + xmlText(this._transaction.path)];

    for (const line of this._transaction.description.replace(/\r\n/g, '\n').split('\n')) {
      if (line.trim().length > 0) {
        lines.push('/// ' + xmlText(line.trim()));
      }
    }

    lines.push('/// </summary>');
    lines.push(...this._signature(isPublic));
    lines.push('{');

    // outputs live for the whole method (they are returned); locals and action results move to where they are set
    const body = this._contract.outputs.flatMap((output) => withMiiName(output.type.name + ' ' + output.name + ' = ' + output.initializer + ';', 'Transaction.' + output.miiName));
    const candidates = [];
    const configuration = [];

    for (const local of this._contract.locals) {
      if (local.initializer === ContractBuilder.emptyValue(local.type)) {
        candidates.push({ type: local.type.name, name: local.name, miiName: 'Local.' + local.miiName, initializer: local.initializer, isCatch: false });
      } else {
        configuration.push(...withMiiName(local.type.name + ' ' + local.name + ' = ' + local.initializer + ';', 'Local.' + local.miiName));
      }
    }

    for (const definition of this._transaction.actions.values()) {
      const symbol = this._actions.get(definition.name);

      if (symbol.variable !== null) {
        candidates.push({ type: symbol.variableType.name, name: symbol.variable, miiName: 'action ' + definition.name, initializer: symbol.initializer, isCatch: symbol.kind === ActionKind.Catch });
      }
    }

    for (const variable of placeDeclarations(flow, candidates)) {
      body.push(...withMiiName(variable.type + ' ' + variable.name + ' = ' + variable.initializer + ';', variable.miiName));
    }

    body.push(...configuration);

    if (flow.length > 0) {
      if (body.length > 0) {
        body.push('');
      }

      body.push(...flow);
    }

    if (this._contract.outputs.length > 0) {
      body.push('', this._contract.returnStatement);
    }

    lines.push(...indent(body), '}');
    return lines;
  }

  /** Every parameter is optional: a caller passes the inputs MII links, the others stay empty. One parameter per line
   * with its MII name. */
  _signature(isPublic) {
    const inputs = this._contract.inputs;
    const head = (isPublic ? 'public ' : 'private ') + this._contract.returnTypeName + ' ' + this._contract.methodName + '(';

    if (inputs.length === 0) {
      return [head + ')'];
    }

    return [head].concat(inputs.map((input, index) => '    ' + input.type.name + ' ' + input.name + ' = default'
      + (index < inputs.length - 1 ? ',' : ')') + ' // Transaction.' + input.miiName));
  }

  /** Steps in order; a Catch wraps everything before it (including the lines passed in) in a try block. */
  _emitSiblings(steps, before) {
    let lines = before;

    for (const step of steps) {
      if (step.stepType === 'Catch') {
        lines = this._wrapInTry(lines, step);
      } else {
        lines.push(...this._emitStep(step));
      }
    }

    return lines;
  }

  _emitStep(step) {
    switch (step.stepType) {
      case 'Conditional':
        return this._emitConditional(step);
      case 'Switcher':
        return this._emitSwitcher(step);
      case 'Iterator':
      case 'Repeater':
      case 'ForNextRepeater':
      case 'WhileRepeater':
        return this._emitLoop(step);
      case 'Catch':
        return this._wrapInTry([], step);
      default: {
        const lines = [];

        if (step.stepType !== 'ActionSequence') {
          lines.push('// X-Ray: unknown step type ' + step.stepType + ', run as a sequence');
        }

        if (step.action) {
          lines.push(...this._emitAction(step.action));
        }

        return this._emitSiblings(step.children, lines);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------- exception handling

  _wrapInTry(guarded, catchStep) {
    const name = catchStep.action ? catchStep.action.name : catchStep.name;
    this._currentAction = name;

    if (!hasCode(guarded)) {
      guarded.push('// ' + name + ': catches nothing (no action runs before it), its handler never runs');
      return guarded;
    }

    const symbol = catchStep.action ? this._actions.get(catchStep.action.name) || null : null;
    const error = this._names.claim(Naming.camel(name) + 'Error');
    const handler = ['// ' + name];

    if (guarded.some((line) => line.includes(TERMINATION_MARKER))) {
      // Terminate Transaction is no exception in MII: a Catch does not stop it
      handler.push('if (Mii.IsTerminationOf(' + error + ', ' + CsLiteral.string(this._transaction.path) + '))', '{', '    throw;', '}');
    }

    if (symbol && symbol.variable !== null) {
      handler.push(symbol.variable + ' = ' + error + ';');
    }

    if (catchStep.action) {
      handler.push(...this._emitOutgoing(catchStep.action));
    }

    // only the first child of a Catch is its handler; further children do not belong to it
    this._flow.push('on error ' + name);
    const children = this._emitSiblings(catchStep.children.slice(0, 1), []);
    this._flow.pop();
    handler.push(...children);

    if (!hasCode(children) && !(symbol && symbol.variable !== null)) {
      handler.push('// the exception is swallowed');
    }

    const result = ['try', '{', ...indent(guarded), '}', 'catch (Exception ' + error + ')', '{', ...indent(handler), '}'];

    if (catchStep.children.length > 1) {
      this.note('the Catch ' + name + ' has ' + catchStep.children.length + ' children: only the first is its handler, the others are not (when they run is not documented)');
      result.push('// further children of the Catch ' + name + ': not part of its handler (when MII runs them is not documented)');
      result.push(...this._emitSiblings(catchStep.children.slice(1), []));
    }

    return result;
  }

  // ---------------------------------------------------------------------------------------------- branches

  _emitConditional(step) {
    const lines = [];
    const use = step.action;

    if (!use || !use.definition) {
      lines.push('// X-Ray: conditional step ' + step.name + ' without action; its paths follow as a sequence');
      return this._emitSiblings(step.children, lines);
    }

    this._currentAction = use.name;
    const count = parseCount(use.definition.static('InputCount'), 1);
    const logicalAnd = use.definition.static('LogicalAnd').length === 0 || CsLiteral.isTrue(use.definition.static('LogicalAnd'));
    const terms = [];

    for (let index = 1; index <= count; index++) {
      terms.push(this._inputValue(use, 'Input' + index, CsType.Bool) || TypedCode.primary('false', CsType.Bool));
    }

    const condition = combine(terms, logicalAnd);
    lines.push('// ' + use.name);

    for (const link of use.incoming) {
      const property = linkTarget(link.to).property;

      if (!/^Input\d+$/.test(property) && property !== 'InputCount' && property !== 'LogicalAnd') {
        // e.g. a link into Output: what MII does with it is not documented, the condition only reads the inputs
        this.note('link into ' + link.to + ' (the condition reads only the inputs Input1..' + count + '): ' + oneLine(link.from));
        lines.push('// X-Ray: not part of the condition: ' + oneLine(link.to) + ' = ' + oneLine(link.from));
      }
    }
    lines.push(...this._emitOutgoing(use));
    const alwaysTrue = condition.code === 'true';
    const whenTrue = this._emitBranch(step.children, 0, alwaysTrue ? null : 'if ' + use.name);
    const whenFalse = this._emitBranch(step.children, 1, 'else ' + use.name);

    if (condition.code === 'true' && !hasCode(whenFalse)) {
      lines[0] = '// ' + use.name + ': always true';
      lines.push(...whenTrue);
    } else {
      lines.push('if (' + condition.code + ')', '{', ...indent(whenTrue), '}');

      if (hasCode(whenFalse)) {
        lines.push('else', '{', ...indent(whenFalse), '}');
      }
    }

    return this._emitSiblings(step.children.slice(2), lines);
  }

  _emitSwitcher(step) {
    const lines = [];
    const use = step.action;

    if (!use || !use.definition) {
      lines.push('// X-Ray: switch step ' + step.name + ' without action; its paths follow as a sequence');
      return this._emitSiblings(step.children, lines);
    }

    this._currentAction = use.name;
    const matchCount = parseCount(use.definition.static('MatchCount'), 0);
    const subject = this._inputValue(use, 'InputValue', CsType.String) || TypedCode.primary('""', CsType.String);
    const variable = this._names.claim(Naming.camel(use.name) + 'Value');
    lines.push('// ' + use.name, 'var ' + variable + ' = ' + subject.code + ';');
    lines.push(...this._emitOutgoing(use));

    for (let index = 0; index <= matchCount && index < step.children.length; index++) {
      const branch = this._emitBranch(step.children, index, index < matchCount ? 'case ' + (index + 1) + ' of ' + use.name : 'default of ' + use.name);

      if (index < matchCount) {
        const match = this._inputValue(use, 'MatchValue' + (index + 1), CsType.String) || TypedCode.primary('""', CsType.String);
        lines.push((index === 0 ? 'if (' : 'else if (') + variable + ' == ' + match.at(Precedence.Equality + 1) + ')');
      } else {
        if (!hasCode(branch)) {
          break;
        }

        lines.push(matchCount === 0 ? '// default path' : 'else');
      }

      lines.push('{', ...indent(branch), '}');
    }

    return this._emitSiblings(step.children.slice(matchCount + 1), lines);
  }

  /** A branch step with its flow context for the call tree (null = no context, e.g. an always-true condition). */
  _emitBranch(children, index, context) {
    if (index >= children.length) {
      return [];
    }

    if (context !== null) {
      this._flow.push(context);
    }

    const lines = this._emitStep(children[index]);

    if (context !== null) {
      this._flow.pop();
    }

    return lines;
  }

  // ---------------------------------------------------------------------------------------------- loops

  _emitLoop(step) {
    const lines = [];
    const use = step.action;

    if (!use || !use.definition) {
      lines.push('// X-Ray: loop step ' + step.name + ' without action; its body follows as a sequence');
      return this._emitSiblings(step.children, lines);
    }

    this._currentAction = use.name;
    const type = use.definition.actionType;
    const loop = { actionName: use.name, actionType: type, item: null, index: null, count: null, breakVariable: null };
    const camel = Naming.camel(use.name);
    lines.push('// ' + use.name);

    if (this._isLinkTarget(use.name, 'Break')) {
      loop.breakVariable = this._names.claim(camel + 'Break');
      lines.push('var ' + loop.breakVariable + ' = false;');
    }

    let header;
    let countsItems = false;

    if (type === 'ForNextRepeaterAction') {
      header = this._forHeader(use, loop, camel);
    } else if (type === 'WhileRepeaterAction') {
      const counter = this._names.claim(camel + 'Iteration');
      const maximum = this._inputValue(use, 'MaxIterations', CsType.Int) || TypedCode.primary('int.MaxValue', CsType.Int);
      loop.index = TypedCode.primary(counter, CsType.Int);
      header = 'for (int ' + counter + ' = 1; ' + counter + ' <= ' + maximum.at(Precedence.Relational + 1) + '; ' + counter + '++)';

      if (loop.breakVariable === null) {
        this.note('a while loop without a Break link never ends before MaxIterations');
      }
    } else {
      header = this._forEachHeader(use, loop, camel, lines);
      countsItems = type === 'RepeaterAction' && this._isReferenced(use.name, 'CurrentItem');

      if (countsItems) {
        const index = this._names.claim(camel + 'Index');
        loop.index = TypedCode.primary(index, CsType.Int);
        lines.push('var ' + index + ' = 0;');
      }
    }

    this._loops.push(loop);
    this._flow.push('loop ' + use.name);
    const body = [];

    if (loop.breakVariable !== null) {
      body.push('if (' + loop.breakVariable + ')', '{', '    break;', '}');
    }

    if (countsItems) {
      body.push(loop.index.code + '++;');
    }

    body.push(...this._emitOutgoing(use));

    if (step.children.length > 0) {
      body.push(...this._emitStep(step.children[0]));
    }

    this._loops.pop();
    this._flow.pop();
    lines.push(header, '{', ...indent(body), '}');
    return this._emitSiblings(step.children.slice(1), lines);
  }

  _forHeader(use, loop, camel) {
    const counter = this._names.claim(camel + 'Counter');
    const from = this._inputValue(use, 'From', CsType.Int) || TypedCode.primary('0', CsType.Int);
    const to = this._inputValue(use, 'To', CsType.Int) || TypedCode.primary('0', CsType.Int);
    const increment = this._inputValue(use, 'Step', CsType.Int) || TypedCode.primary('1', CsType.Int);
    loop.index = TypedCode.primary(counter, CsType.Int);
    const down = increment.isLiteral && increment.code.startsWith('-');
    const step = increment.code === '1' ? counter + '++' : counter + ' += ' + increment.code;
    return 'for (int ' + counter + ' = ' + from.code + '; ' + counter + (down ? ' >= ' : ' <= ') + to.at(Precedence.Relational + 1) + '; ' + step + ')';
  }

  /** Repeater over Doc{xpath} (typed rows when Doc is a known rowset and the XPath selects its rows) or Iterator over a list. */
  _forEachHeader(use, loop, camel, lines) {
    const itemName = this._names.claim(camel + 'Item');
    const sourceText = this._linkedOrStatic(use, 'Source');

    if (use.definition.actionType === 'IteratorAction') {
      let list = convertTo(this._translator.translate(sourceText), CsType.List);

      if (this._isReferenced(use.name, 'ItemCount')) {
        const items = this._names.claim(camel + 'Items');
        lines.push('var ' + items + ' = ' + list.code + ';');
        list = TypedCode.primary(items, CsType.List);
        loop.count = TypedCode.primary(items + '.Count', CsType.Int);
      }

      loop.item = TypedCode.primary(itemName, CsType.String);
      return 'foreach (var ' + itemName + ' in ' + list.code + ')';
    }

    const reference = parseQuietly(sourceText);

    if (reference && reference.node === 'Reference' && reference.selector !== null) {
      let baseCode = this.resolve({ node: 'Reference', path: reference.path, selector: null });

      if (baseCode === null) {
        this.note('unknown reference ' + reference.path);
        baseCode = this._translator.unresolved(reference.path);
      }

      const path = reference.selector.trim();

      if (baseCode.type.kind === TypeKind.Rowset && (path === '/Rowsets/Rowset/Row' || path === 'Rowsets/Rowset/Row')) {
        loop.item = TypedCode.primary(itemName, CsType.rowOf(baseCode.type.contract));
        loop.count = TypedCode.primary(baseCode.at(Precedence.Primary) + '.Count', CsType.Int);
        return 'foreach (var ' + itemName + ' in ' + baseCode.code + ')';
      }

      const nodes = this._names.claim(camel + 'Nodes');
      lines.push('var ' + nodes + ' = Mii.SelectNodes(' + baseCode.code + ', ' + CsLiteral.string(path) + ');');
      loop.item = TypedCode.primary(itemName, CsType.Xml);
      loop.count = TypedCode.primary(nodes + '.Count', CsType.Int);
      return 'foreach (var ' + itemName + ' in ' + nodes + ')';
    }

    const source = this._translator.translate(sourceText);
    const fallback = this._names.claim(camel + 'Nodes');
    this.note(sourceText.trim().length === 0 ? 'repeater without source, it runs over nothing'
      : 'repeater source without XPath, iterating the children of the root element: ' + oneLine(sourceText));
    lines.push('var ' + fallback + ' = Mii.SelectNodes(' + source.code + ', "/*/*");');
    loop.item = TypedCode.primary(itemName, CsType.Xml);
    loop.count = TypedCode.primary(fallback + '.Count', CsType.Int);
    return 'foreach (var ' + itemName + ' in ' + fallback + ')';
  }

  // ---------------------------------------------------------------------------------------------- links

  /** The expression text of the last plain incoming link to Action.Property, or the configured value. */
  _linkedOrStatic(use, property) {
    const link = plainIncoming(use, property);
    return link ? link.from : use.definition.static(property);
  }

  /** An action property as C#: the linked expression, else the configured value as a literal; null when neither. */
  _inputValue(use, property, type) {
    const link = plainIncoming(use, property);

    if (link) {
      return convertTo(this._linkValue(link, type), type);
    }

    if (!use.definition || !use.definition.hasProperty(property)) {
      return null;
    }

    const configured = use.definition.static(property);

    if (configured.length === 0 && type.kind !== TypeKind.String) {
      return null;
    }

    return staticValue(configured, type);
  }

  _linkValue(link, target) {
    const value = this._translator.translate(link.from);

    if (link.kind === 'AssignXml' && value.xmlCode !== null && target.kind !== TypeKind.String) {
      return TypedCode.primary(value.xmlCode, CsType.Xml);
    }

    return value;
  }

  _emitOutgoing(use) {
    const lines = [];

    for (const link of use.outgoing) {
      lines.push(...this._emitWrite(link));
    }

    return lines;
  }

  /** One outgoing link: Transaction.X, Local.X, a loop's Break or (rarely) another action's result. */
  _emitWrite(link) {
    const target = linkTarget(link.to);
    const dot = target.path.indexOf('.');
    const scope = dot >= 0 ? target.path.substring(0, dot) : target.path;
    const member = target.property;

    if (scope === 'Transaction') {
      const property = this._contract.findOutput(member) || this._contract.findInput(member);

      if (property) {
        return this._write(TypedCode.primary(property.name, property.type), target.selector, link);
      }
    } else if (scope === 'Local') {
      const local = this._contract.findLocal(member);

      if (local) {
        return this._write(TypedCode.primary(local.name, local.type), target.selector, link);
      }
    } else if (SHARED_SCOPES.includes(scope) && target.selector === null) {
      return ['plugins.SetProperty(' + CsLiteral.string(target.path) + ', ' + this._linkValue(link, CsType.Object).code + ');'];
    } else if (member === 'Break') {
      const loop = this._findLoop(scope);

      if (loop && loop.breakVariable !== null) {
        return this._write(TypedCode.primary(loop.breakVariable, CsType.Bool), null, link);
      }
    }

    const action = this._actions.get(scope);

    if (action && action.variable !== null && isWritableResult(action, member)) {
      return this._write(TypedCode.primary(action.variable, action.variableType), target.selector, link);
    }

    this.note('link to ' + link.to + ' has no C# target');
    return ['// X-Ray: not translated: ' + oneLine(link.to) + ' = ' + oneLine(link.from)];
  }

  /** Assign = value assignment, AssignXml = replace the document or the selected node, RemoveXml / AppendXml /
   * AppendAfterXml / ReplaceXml = XML edits at the selected node. */
  _write(target, selector, link) {
    const kind = link.kind;

    if (kind === 'RemoveXml') {
      return [this._removeXml(target, selector)];
    }

    const value = this._linkValue(link, target.type);
    const xmlTarget = target.type.kind === TypeKind.Xml || target.type.kind === TypeKind.Rowset || target.type.kind === TypeKind.Row;

    if (kind === 'AssignXml' && xmlTarget && value.type.kind === TypeKind.String && value.xmlCode === null) {
      // text reaches an XML target only through Assign (Assign Value); Assign XML of text delivers nothing
      this.note('Assign XML of a text into ' + link.to + ' has no effect in MII (text needs Assign Value): ' + oneLine(link.from));
      return ['// X-Ray: no effect in MII (Assign XML of a text; the target keeps its value): ' + oneLine(link.to) + ' = ' + oneLine(link.from)];
    }

    if (selector === null && (kind === 'Assign' || kind === 'AssignXml')) {
      return [target.code + ' = ' + convertTo(value, target.type).code + ';'];
    }

    const pathCode = selector === null ? '"/*"' : this._translator.selectorPathCode(selector);

    if (kind === 'Assign' && selector !== null) {
      const direct = directSelectorWrite(target, selector, value);

      if (direct !== null) {
        return [direct];
      }
    }

    let method;

    switch (kind) {
      case 'Assign': method = 'Mii.SetXPathValue'; break;
      case 'AssignXml': method = 'Mii.AssignXml'; break;
      case 'AppendXml': method = 'Mii.AppendXml'; break;
      case 'AppendAfterXml': method = 'Mii.AppendAfterXml'; break;
      case 'ReplaceXml': method = 'Mii.ReplaceXml'; break;
      default:
        this.note('unknown link type ' + kind);
        method = 'Mii.SetXPathValue';
        break;
    }

    return [xmlEdit(target, method, pathCode + ', ' + value.code)];
  }

  _removeXml(target, selector) {
    const path = selector ?? '/*';

    if (target.type.kind === TypeKind.Rowset && (path === '/*' || path === '/Rowsets/Rowset/Row' || path === '/Rowsets/Rowset/Row/*')) {
      return target.code + '.Clear();';
    }

    return xmlEdit(target, 'Mii.RemoveXml', this._translator.selectorPathCode(path));
  }

  // ---------------------------------------------------------------------------------------------- actions

  _emitAction(use) {
    this._currentAction = use.name;

    if (!use.definition) {
      this.note('action definition missing');
      return ['// X-Ray: action ' + use.name + ' has no definition in the transaction'];
    }

    const symbol = this._actions.get(use.name);
    const lines = ['// ' + use.name];

    switch (use.definition.actionType) {
      case 'Assignment':
      case 'CatchAction':
        break;
      case 'Throw':
        lines.push(...this._emitThrow(use));
        return lines;
      case 'TerminateTransaction':
        lines.push(...this._emitTerminate(use));
        return lines;
      case 'Tracer':
        lines.push('plugins.Log(' + this._logText(use, 'Level', 'DEBUG') + ', ' + this._messageOf(use, 'Message') + ');');
        break;
      case 'EventLogger':
        lines.push('plugins.Log(' + this._logText(use, 'EventType', 'INFO') + ', ' + this._messageOf(use, 'Message') + ');');
        break;
      case 'Pause': {
        const delay = this._inputValue(use, 'Delay', CsType.Int) || TypedCode.primary('0', CsType.Int);
        lines.push('Thread.Sleep(' + delay.code + ');');
        break;
      }
      case 'IlluminatorRow':
        lines.push(...this._emitAddRow(use));
        break;
      case 'IlluminatorDocument':
        if (symbol.variable !== null) {
          lines.push(symbol.variable + ' = new ' + symbol.variableType.name + '();');
        }

        break;
      case 'StringToXmlConverter':
        lines.push(assign(symbol, 'Mii.ParseXml(' + toStringCode(this._inputValue(use, 'Input', CsType.String) || TypedCode.primary('""', CsType.String)).code + ')'));
        break;
      case 'XSLTransform':
        lines.push(...this._emitXslTransform(use, symbol));
        break;
      default:
        lines.push(...this._emitCall(use, symbol));
        break;
    }

    lines.push(...this._emitOutgoing(use));
    return lines;
  }

  _messageOf(use, property) {
    return (this._inputValue(use, property, CsType.String) || TypedCode.primary('""', CsType.String)).code;
  }

  _logText(use, property, fallback) {
    const level = this._inputValue(use, property, CsType.String);
    return level === null || (level.isLiteral && level.literalText.length === 0) ? CsLiteral.string(fallback) : level.code;
  }

  _emitThrow(use) {
    const statement = 'throw new MiiException(' + this._messageOf(use, 'Message') + ', ' + CsLiteral.string(use.name) + ');';
    const enable = this._inputValue(use, 'Enable', CsType.Bool);

    if (enable === null || enable.code === 'true') {
      return [statement];
    }

    if (enable.code === 'false') {
      return ['// disabled in MII (Enable = false): ' + statement];
    }

    return ['if (' + enable.code + ')', '{', '    ' + statement, '}'];
  }

  _emitTerminate(use) {
    const lines = [];
    const withError = this._inputValue(use, 'TerminateWithError', CsType.Bool) || TypedCode.primary('false', CsType.Bool);
    let message = this._inputValue(use, 'TerminationMessage', CsType.String);

    if (message === null || (message.isLiteral && message.literalText.length === 0)) {
      message = TypedCode.primary(CsLiteral.string('Transaction Execution Terminated Upon Request'), CsType.String);
    }

    const statement = 'throw ' + TERMINATION_MARKER + CsLiteral.string(this._transaction.path) + ', ' + message.code + ');';

    if (withError.code === 'true') {
      return [statement];
    }

    if (withError.code !== 'false') {
      lines.push('if (' + withError.code + ')', '{', '    ' + statement, '}');
    }

    lines.push(...this._emitOutgoing(use), this._contract.returnStatement);
    return lines;
  }

  _emitXslTransform(use, symbol) {
    const input = this._inputValue(use, 'Input', CsType.Xml) || TypedCode.primary('new XmlDocument()', CsType.Xml);
    const stylesheet = this._inputValue(use, 'InputXSL', CsType.Xml);
    let stylesheetCode;

    if (stylesheet !== null && !(stylesheet.isLiteral && stylesheet.literalText.trim().length === 0)) {
      stylesheetCode = stylesheet.code;
    } else {
      const path = this._inputValue(use, 'Transform', CsType.String) || TypedCode.primary('""', CsType.String);
      stylesheetCode = 'plugins.LoadResource(' + path.code + ')';
    }

    return [assign(symbol, 'Mii.XslTransform(' + input.code + ', ' + stylesheetCode + ')')];
  }

  /** IlluminatorRow: a new row of the document created by an IlluminatorDocument action. */
  _emitAddRow(use) {
    const document = this._translator.translate(this._linkedOrStatic(use, 'IlluminatorDocument'));
    const values = [];

    for (const link of use.incoming) {
      const target = linkTarget(link.to);

      if (target.selector === null && target.property !== 'IlluminatorDocument') {
        values.push([target.property, this._translator.translate(link.from)]);
      }
    }

    if (document.type.kind !== TypeKind.Rowset) {
      this.note("the row's document is not a known rowset; the row is added through Mii.AddRow");
      const args = [];

      for (const [key, value] of values) {
        args.push(CsLiteral.string(key), value.code);
      }

      return ['Mii.AddRow(' + document.code + (args.length > 0 ? ', ' + args.join(', ') : '') + ');'];
    }

    const contract = document.type.contract;
    const assignments = values.map(([key, value]) => {
      const column = contract.ensure(key);
      return column.propertyName + ' = ' + convertTo(value, column.type).code;
    });
    return [document.at(Precedence.Primary) + '.Add(new ' + contract.rowTypeName + initializerList(assignments) + ');'];
  }

  _emitCall(use, symbol) {
    this._record(use, symbol);

    switch (symbol.kind) {
      case ActionKind.TransactionCall:
        return this._emitTransactionCall(use, symbol);
      case ActionKind.Xacute:
        return this._emitXacuteCall(use, symbol);
      case ActionKind.Query:
      case ActionKind.QueryCommand:
        return this._emitQuery(use, symbol);
      default:
        return this._emitPluginCall(use, symbol);
    }
  }

  /** Notes the call for the call tree and the query overview of the file header. */
  _record(use, symbol) {
    const entry = { actionName: use.name, flow: this._flow.join(' > '), callee: symbol.callee, kind: null, target: null };

    if (symbol.query) {
      entry.kind = symbol.callee ? 'call' : 'query';
      entry.target = symbol.callee ? symbol.callee.methodName + ' via Xacute query ' + symbol.query.query.shortName : symbol.query.query.shortName;
      symbol.query.callers.push(this._contract.methodName + '.' + use.name + (entry.flow.length > 0 ? ' [' + entry.flow + ']' : ''));
    } else if (symbol.callee) {
      entry.kind = 'call';
      entry.target = symbol.callee.methodName;
    } else {
      entry.kind = 'plugin';
      const transaction = use.definition.static('TransactionName');
      entry.target = use.definition.actionType + (transaction.length > 0 ? ' ' + transaction : '');

      if (use.definition.actionType === 'TransactionCall' && linkedExpression(this._transaction, use.name, 'TransactionName') !== null) {
        entry.target = 'TransactionCall chosen at runtime' + (transaction.length > 0 ? ' (interface ' + transaction + ')' : '');
      }
    }

    this._contract.outline.push(entry);
  }

  _emitTransactionCall(use, symbol) {
    const lines = [];
    const callee = symbol.callee;

    const asyncLink = plainIncoming(use, 'Async');

    if (asyncLink) {
      lines.push('// MII runs this call asynchronously when ' + oneLine(asyncLink.from) + ' is true: then without outputs, and a failure does not reach this transaction');
    } else if (CsLiteral.isTrue(use.definition.static('Async'))) {
      lines.push('// MII runs this call asynchronously: without outputs, and a failure does not reach this transaction');
    }

    const resetLink = plainIncoming(use, 'ResetState');
    const resets = resetLink ? CsLiteral.isTrue(resetLink.from.trim().replace(/^"|"$/g, '')) : CsLiteral.isTrue(use.definition.static('ResetState'));

    if (this._loops.length > 0 && !resets) {
      // verified: with ResetState false the callee keeps its locals and outputs between the calls of one run
      lines.push('// ResetState is false: on each pass the called transaction starts with the locals and outputs of its previous call');
    }

    const inputs = [];

    for (const link of use.incoming) {
      const target = linkTarget(link.to);

      if (CALL_SETTINGS.includes(target.property)) {
        continue;
      }

      const input = callee.findInput(target.property);

      if (!input) {
        lines.push('// X-Ray: ' + callee.methodName + ' has no input ' + target.property + ' (stale link): ' + oneLine(link.from));
        this.note('link to ' + link.to + ': the called transaction has no such input');
        continue;
      }

      inputs.push([input, link]);
    }

    lines.push(...this._emitMethodCall(use, symbol, inputs));
    return lines;
  }

  /** An Xacute query is an interface to a transaction: Param.N goes to the mapped input, Results is the selected output. */
  _emitXacuteCall(use, symbol) {
    const callee = symbol.callee;
    const query = symbol.query.query;
    const lines = ['// Xacute query ' + query.path + ' runs ' + callee.transaction.path];
    const inputs = [];

    for (const link of use.incoming) {
      const target = linkTarget(link.to);
      const slot = PARAM_SLOT.exec(target.property);

      if (!slot) {
        continue;
      }

      const mapped = query.xacuteMappedTargets.get(parseInt(slot[1], 10));
      const input = mapped !== undefined ? callee.findInput(mapped) : null;

      if (!input) {
        lines.push('// X-Ray: ' + target.property + ' is not mapped to an input of ' + callee.methodName + ': ' + oneLine(link.from));
        continue;
      }

      inputs.push([input, link]);
    }

    lines.push(...this._emitMethodCall(use, symbol, inputs));
    return lines;
  }

  /** The call of a transaction's method with named arguments; an input filled through XPath links is built first. */
  _emitMethodCall(use, symbol, inputs) {
    const lines = [];
    const order = [];
    const values = new Map();
    const documents = new Map();

    for (const [input, link] of inputs) {
      const target = linkTarget(link.to);

      if (!order.includes(input.name)) {
        order.push(input.name);
      }

      if (target.selector === null && link.kind !== 'RemoveXml') {
        const value = convertTo(this._linkValue(link, input.type), input.type);

        if (documents.has(input.name)) {
          lines.push(documents.get(input.name) + ' = ' + convertTo(value, CsType.Xml).code + ';');
        } else {
          values.set(input.name, value.code);
        }

        continue;
      }

      let name = documents.get(input.name);

      if (name === undefined) {
        name = this._names.claim(Naming.camel(use.name) + Naming.pascal(input.miiName).replace(/^@/, ''));
        const initial = values.has(input.name) ? 'Mii.ToXml(' + values.get(input.name) + ')' : 'new XmlDocument()';
        lines.push('var ' + name + ' = ' + initial + ';');
        documents.set(input.name, name);
      }

      lines.push(...this._write(TypedCode.primary(name, CsType.Xml), target.selector === null ? '/*' : target.selector, link));
      values.set(input.name, convertTo(TypedCode.primary(name, CsType.Xml), input.type).code);
    }

    const args = order.map((name) => name + ': ' + values.get(name));
    lines.push(assign(symbol, symbol.callee.methodName + argumentList(args)));
    return lines;
  }

  /** A query as a local Query variable: the statement, then AddParameter per linked or configured slot. */
  _emitQuery(use, symbol) {
    const lines = [];
    const query = symbol.query;
    const args = new Map();
    let text = CsLiteral.string(query.query.text);

    for (const link of use.incoming) {
      const target = linkTarget(link.to);
      const slot = PARAM_SLOT.exec(target.property);

      if (slot && target.selector === null) {
        args.set(parseInt(slot[1], 10), toStringCode(this._translator.translate(link.from)).code);
      } else if (target.property === 'Query' && target.selector === null) {
        text = toStringCode(this._translator.translate(link.from)).code;
        lines.push('// the statement is built at runtime instead of the template text');
      } else if (!QUERY_SETTINGS.includes(target.property)) {
        lines.push('// X-Ray: query setting not translated: ' + oneLine(link.to) + ' = ' + oneLine(link.from));
      }
    }

    for (const property of MiiXml.childElements(use.definition.value)) {
      const slot = PARAM_SLOT.exec(property.localName);

      if (!slot) {
        continue;
      }

      const number = parseInt(slot[1], 10);
      const configured = MiiXml.ownText(property);

      if (!args.has(number) && configured.trim().length > 0) {
        args.set(number, CsLiteral.string(configured));
      }
    }

    if (query.parameters.length > 0) {
      lines.push(query.parameterComment());
    }

    const variable = this._names.claim(query.variableName);
    lines.push('var ' + variable + ' = new Query(' + text + ');');

    for (const number of [...args.keys()].sort((a, b) => a - b)) {
      const parameter = query.findParameter(number);

      if (!parameter) {
        lines.push('// X-Ray: Param.' + number + ' is not used by the query text: ' + oneLine(args.get(number)));
        continue;
      }

      lines.push(query.addParameterCode(variable, parameter, args.get(number)));
    }

    if (symbol.kind !== ActionKind.QueryCommand) {
      // RowCount: linked on the action, else configured on the action, else the template's
      const rowCountLink = plainIncoming(use, 'RowCount');
      const configured = [use.definition.static('RowCount'), query.query.rowCount].find((value) => /^\s*[1-9]\d*\s*$/.test(value || ''));

      if (rowCountLink) {
        lines.push(variable + '.RowCount = ' + convertTo(this._linkValue(rowCountLink, CsType.Int), CsType.Int).code + ';');
      } else if (configured !== undefined) {
        lines.push(variable + '.RowCount = ' + configured.trim() + ';');
      }
    }

    if (symbol.kind === ActionKind.QueryCommand) {
      lines.push('queries.ExecuteCommand(' + variable + ');');
    } else {
      lines.push(assign(symbol, 'queries.Execute<' + query.result.rowTypeName + '>(' + variable + ')'));
    }

    return lines;
  }

  /** Any other MII action: an IPluginService call with the action's configuration and linked values. */
  _emitPluginCall(use, symbol) {
    const lines = [];
    const definition = use.definition;

    if (definition.actionType === 'TransactionCall' && linkedExpression(this._transaction, use.name, 'TransactionName') !== null) {
      lines.push('// the called transaction is chosen at runtime (TransactionName); ' + definition.static('TransactionName') + ' is only its interface');
    }
    const settings = [];
    const linked = new Set();
    const selectorLinks = new Map();

    for (const link of use.incoming) {
      const target = linkTarget(link.to);
      linked.add(target.property);

      if (target.selector !== null) {
        if (!selectorLinks.has(target.property)) {
          selectorLinks.set(target.property, []);
        }

        selectorLinks.get(target.property).push(link);
      }
    }

    for (const property of MiiXml.childElements(definition.value)) {
      const name = property.localName;

      if (linked.has(name) || NOISE_PROPERTIES.includes(name) || (property.children.length > 0 && MiiXml.childElements(property).length > 0 && name !== 'Request')) {
        continue;
      }

      let value = MiiXml.ownText(property).trim();

      if (TRIVIAL_VALUES.includes(value) || value.startsWith('<')) {
        continue;
      }

      if (SECRET.test(name)) {
        value = '***';
      }

      settings.push('[' + CsLiteral.string(name) + '] = ' + CsLiteral.string(value));
    }

    for (const link of use.incoming) {
      const target = linkTarget(link.to);

      if (target.selector === null && !selectorLinks.has(target.property) && link.kind !== 'RemoveXml') {
        settings.push('[' + CsLiteral.string(target.property) + '] = ' + this._linkValue(link, CsType.Object).code);
      }
    }

    for (const [property, links] of selectorLinks) {
      // a document filled through XPath links, starting from the configured template
      const document = this._names.claim(Naming.camel(use.name) + Naming.pascal(property).replace(/^@/, ''));
      const template = MiiXml.ownText(definition.property(property)).trim();
      const whole = plainIncoming(use, property);

      if (whole) {
        lines.push('var ' + document + ' = ' + convertTo(this._linkValue(whole, CsType.Xml), CsType.Xml).code + ';');
      } else {
        lines.push('var ' + document + ' = ' + (MiiXml.tryParse(template) ? ContractBuilder.initializer(CsType.Xml, template) : 'new XmlDocument()') + ';');
      }

      for (const link of links) {
        const target = linkTarget(link.to);

        if (target.selector !== null) {
          lines.push(...this._write(TypedCode.primary(document, CsType.Xml), target.selector, link));
        }
      }

      settings.push('[' + CsLiteral.string(property) + '] = ' + document);
    }

    const callCode = 'plugins.Invoke(' + CsLiteral.string(definition.actionType) + ', ' + CsLiteral.string(use.name) + ', new()' + initializerList(settings) + ')';
    lines.push(assign(symbol, callCode.replace('new()()', 'new()')));
    return lines;
  }
}

// ---------------------------------------------------------------------------------------------- helpers

function resolveLoopMember(loop, member) {
  switch (member) {
    case 'Item':
    case 'Output':
      return loop.item;
    case 'CurrentItem':
      return loop.actionType === 'IteratorAction' ? loop.item : loop.index;
    case 'ItemCount':
      return loop.count;
    case 'Break':
      return loop.breakVariable !== null ? TypedCode.primary(loop.breakVariable, CsType.Bool) : TypedCode.primary('false', CsType.Bool);
    default:
      return null;
  }
}

function resolveActionMember(symbol, member) {
  if (symbol.variable === null) {
    return null;
  }

  const variable = TypedCode.primary(symbol.variable, symbol.variableType);

  switch (symbol.kind) {
    case ActionKind.TransactionCall:
      return symbol.callee.outputOf(symbol.variable, member);
    case ActionKind.Xacute:
      return member !== 'Results' ? null : symbol.callee.outputOf(symbol.variable, symbol.query.query.xacuteOutputParameter) || variable;
    case ActionKind.Query:
      if (member === 'Results') {
        return variable;
      }

      return member === 'ResultsAsString' ? TypedCode.primary('Mii.ToStr(' + symbol.variable + ')', CsType.String) : null;
    case ActionKind.Catch:
      return catchMember(symbol.variable, member);
    case ActionKind.Document:
      return member === 'Output' ? variable : null;
    case ActionKind.Xml:
      if (member === 'Output') {
        return variable;
      }

      return member === 'TextOutput' ? TypedCode.primary('Mii.ToStr(' + symbol.variable + ')', CsType.String) : null;
    case ActionKind.Plugin:
      return TypedCode.primary(symbol.variable + '.Get(' + CsLiteral.string(member) + ')', CsType.Object);
    default:
      return null;
  }
}

/** Reading a property the action only configures (e.g. a query's DateFormat): its configured value. */
function configuredValue(symbol, member) {
  const property = symbol.definition.property(member);

  if (!property || MiiXml.childElements(property).length > 0) {
    return null;
  }

  const text = MiiXml.ownText(property).trim();
  const value = TypedCode.primary(CsLiteral.string(text), CsType.String);
  value.isLiteral = true;
  value.literalText = text;
  return value;
}

function catchMember(variable, member) {
  switch (member) {
    case 'Message': return TypedCode.primary('Mii.ExceptionMessage(' + variable + ')', CsType.String);
    case 'ExceptionType': return TypedCode.primary('Mii.ExceptionType(' + variable + ')', CsType.String);
    case 'Source': return TypedCode.primary('Mii.ExceptionSource(' + variable + ')', CsType.String);
    case 'ActionType': return TypedCode.primary('Mii.ExceptionActionType(' + variable + ')', CsType.String);
    case 'ExceptionCaught': return new TypedCode(variable + ' != null', CsType.Bool, Precedence.Equality);
    case 'Succeeded': return TypedCode.primary('true', CsType.Bool);
    default: return null;
  }
}

function plainIncoming(use, property) {
  let result = null;

  for (const link of use.incoming) {
    const target = linkTarget(link.to);

    if (target.selector === null && target.property === property && link.kind !== 'RemoveXml') {
      result = link;
    }
  }

  return result;
}

/** A configured (not linked) property value as a C# literal of the given type. */
function staticValue(text, type) {
  let result;

  switch (type.kind) {
    case TypeKind.Bool:
      result = TypedCode.primary(CsLiteral.isTrue(text) ? 'true' : 'false', CsType.Bool);
      break;
    case TypeKind.Int:
    case TypeKind.Long:
    case TypeKind.Double:
    case TypeKind.Decimal:
      result = TypedCode.primary(CsLiteral.number(text, type.kind), type);

      if (result.code.startsWith('-')) {
        result.precedence = Precedence.Unary;
      }

      break;
    case TypeKind.String:
    case TypeKind.Object:
      result = TypedCode.primary(CsLiteral.string(text), CsType.String);
      break;
    default:
      result = TypedCode.primary(ContractBuilder.initializer(type, text), type);
      break;
  }

  result.isLiteral = true;
  result.literalText = text;
  return result;
}

function isWritableResult(action, member) {
  return (member === 'Output' && (action.kind === ActionKind.Document || action.kind === ActionKind.Xml))
    || (member === 'Results' && action.kind === ActionKind.Query);
}

/** Map{key} = v, Row{/Row/Column} = v: plain C# assignments. */
function directSelectorWrite(target, selector, value) {
  if (target.type.kind === TypeKind.Map && WORD.test(selector)) {
    return target.code + '[' + CsLiteral.string(selector) + '] = ' + toStringCode(value).code + ';';
  }

  const column = SINGLE_ROW_COLUMN_PATH.exec(selector);

  if (target.type.kind === TypeKind.Row && column) {
    const rowColumn = target.type.contract.ensure(column[1]);
    return target.code + '.' + rowColumn.propertyName + ' = ' + convertTo(value, rowColumn.type).code + ';';
  }

  return null;
}

/** An XML edit: in place for an XmlDocument, through a conversion for anything else. */
function xmlEdit(target, method, args) {
  if (target.type.kind === TypeKind.Xml) {
    return method + '(' + target.code + ', ' + args + ');';
  }

  const edited = TypedCode.primary(method + '(Mii.ToXml(' + target.code + '), ' + args + ')', CsType.Xml);
  return target.code + ' = ' + convertTo(edited, target.type).code + ';';
}

function combine(terms, logicalAnd) {
  if (terms.length === 1) {
    return terms[0];
  }

  // a Conditional evaluates every input: & and | instead of the short-circuit && and ||
  const precedence = logicalAnd ? Precedence.BitwiseAnd : Precedence.BitwiseOr;
  return new TypedCode(terms.map((term) => term.at(precedence + 1)).join(logicalAnd ? ' & ' : ' | '), CsType.Bool, precedence);
}

/** "x = value;" when something reads the action's result, else the call as a statement. */
function assign(symbol, callCode) {
  return symbol.variable !== null ? symbol.variable + ' = ' + callCode + ';' : callCode + ';';
}

/** " { A = 1, B = 2 }" or a block with one member per line; "()" when empty. */
function initializerList(members) {
  if (members.length === 0) {
    return '()';
  }

  if (members.length <= 2 && members.join(', ').length <= 80) {
    return ' { ' + members.join(', ') + ' }';
  }

  return '\n{' + members.map((member) => '\n    ' + member + ',').join('') + '\n}';
}

/** "(a: x, b: y)" or one named argument per line. */
function argumentList(args) {
  const single = args.join(', ');

  if (args.length <= 2 && single.length <= 80) {
    return '(' + single + ')';
  }

  return '(' + args.map((arg, index) => '\n    ' + arg + (index < args.length - 1 ? ',' : ')')).join('');
}

function parseQuietly(text) {
  try {
    return parseExpression(text);
  } catch (error) {
    if (error instanceof ExpressionError) {
      return null;
    }

    throw error;
  }
}
