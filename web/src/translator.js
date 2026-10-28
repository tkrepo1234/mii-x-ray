// MII expressions as C#. Known types use native operators; anything else goes through the Mii.* helpers, which take
// object, so the result always compiles.
import { parseExpression, ExpressionError, referenceScope } from './expressions.js';
import { CsType, TypeKind, TypedCode, Precedence, CsLiteral, ValueLiteral } from './types.js';

const ROW_COLUMN = /^\/Rowsets\/Rowset\/Row\/([A-Za-z_][A-Za-z0-9_]*)$/;
const INDEXED_ROW_COLUMN = /^\/Rowsets\/Rowset\/Row\[(\d+)\]\/([A-Za-z_][A-Za-z0-9_]*)$/;
const FILTERED_ROW_COLUMN = /^\/Rowsets\/Rowset\/Row\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*'([^']*)'\s*\]\/([A-Za-z_][A-Za-z0-9_]*)$/;
const ROW_COUNT = /^count\(\s*\/Rowsets\/Rowset\/Row\s*\)$/;
const SINGLE_ROW_COLUMN = /^\/?Row\/([A-Za-z_][A-Za-z0-9_]*)$/;
const WORD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INDEX = /^\d+$/;

const EMPTY_PATTERNS = ['(?i)^\\s*(null|---)?\\s*$', '(?i)^\\s*(null|\\-{3})?\\s*$'];
const TRUE_PATTERN = '(?i)^\\s*(true|1)\\s*$';

function literal(code, type, text) {
  const result = TypedCode.primary(code, type);
  result.isLiteral = true;
  result.literalText = text;
  return result;
}

const call = (method, value, type) => TypedCode.primary(method + '(' + value.code + ')', type);

/** The value as the given type: unchanged when the types match (or C# converts implicitly), else a Mii.To* call. */
export function convertTo(value, target) {
  if (target.kind === TypeKind.Object || value.type.isSameAs(target)) {
    return value;
  }

  if (target.isNumeric && value.type.isNumeric && implicitNumeric(value.type.kind, target.kind)) {
    return value;
  }

  switch (target.kind) {
    case TypeKind.String:
      if (value.isLiteral && (value.type.kind === TypeKind.Int || value.type.kind === TypeKind.Long || value.type.kind === TypeKind.Bool)) {
        return literal(CsLiteral.string(value.literalText), CsType.String, value.literalText);
      }

      return call('Mii.ToStr', value, CsType.String);
    case TypeKind.Bool: return call('Mii.ToBool', value, CsType.Bool);
    case TypeKind.Int: return call('Mii.ToInt', value, CsType.Int);
    case TypeKind.Long: return call('Mii.ToLong', value, CsType.Long);
    case TypeKind.Double: return call('Mii.ToDouble', value, CsType.Double);
    case TypeKind.Decimal: return call('Mii.ToDecimal', value, CsType.Decimal);
    case TypeKind.DateTime: return call('Mii.ToDateTime', value, CsType.DateTime);
    case TypeKind.List: return call('Mii.ToList', value, CsType.List);
    case TypeKind.Map: return call('Mii.ToMap', value, CsType.Map);
    case TypeKind.Xml:
      return value.xmlCode !== null ? TypedCode.primary(value.xmlCode, CsType.Xml) : call('Mii.ToXml', value, CsType.Xml);
    case TypeKind.Rowset:
      return TypedCode.primary('Mii.ToRows<' + target.contract.rowTypeName + '>(' + (value.xmlCode ?? value.code) + ')', target);
    case TypeKind.Row:
      return TypedCode.primary('Mii.ToRow<' + target.contract.rowTypeName + '>(' + (value.xmlCode ?? value.code) + ')', target);
    default:
      return new TypedCode('(' + target.name + ')' + value.at(Precedence.Unary), target, Precedence.Unary);
  }
}

export const toStringCode = (value) => convertTo(value, CsType.String);
export const toBoolCode = (value) => convertTo(value, CsType.Bool);

function implicitNumeric(from, to) {
  if (from === to) {
    return true;
  }

  if (from === TypeKind.Int) {
    return to === TypeKind.Long || to === TypeKind.Double || to === TypeKind.Decimal;
  }

  return from === TypeKind.Long && (to === TypeKind.Double || to === TypeKind.Decimal);
}

function commonNumericType(left, right) {
  if (left.kind === TypeKind.Int && right.kind === TypeKind.Int) {
    return CsType.Int;
  }

  if ((left.kind === TypeKind.Int || left.kind === TypeKind.Long) && (right.kind === TypeKind.Int || right.kind === TypeKind.Long)) {
    return CsType.Long;
  }

  return left.kind === TypeKind.Decimal && right.kind === TypeKind.Decimal ? CsType.Decimal : CsType.Double;
}

function toNumberOf(value, type) {
  if (value.type.isSameAs(type)) {
    return value;
  }

  if (type.kind === TypeKind.Long && value.type.kind === TypeKind.Int) {
    return value;
  }

  if (type.kind === TypeKind.Double && (value.type.kind === TypeKind.Int || value.type.kind === TypeKind.Long)) {
    return value;
  }

  if (type.kind === TypeKind.Double && value.type.kind === TypeKind.Decimal) {
    return new TypedCode('(double)' + value.at(Precedence.Unary), CsType.Double, Precedence.Unary);
  }

  return convertTo(value, type);
}

const toNumericCode = (value) => (value.type.isNumeric ? value : convertTo(value, CsType.Double));
const toDoubleCode = (value) => toNumberOf(value, CsType.Double);

/** MII function -> Mii.* helper and its return type. The helpers take object arguments. */
const HELPERS = new Map();

function helpers(type, ...pairs) {
  for (let index = 0; index + 1 < pairs.length; index += 2) {
    HELPERS.set(pairs[index], { method: 'Mii.' + pairs[index + 1], returnType: type });
  }
}

helpers(CsType.String,
  'stringleft', 'StringLeft', 'stringright', 'StringRight', 'stringpart', 'StringPart',
  'stringreplace', 'StringReplace', 'stringreplaceall', 'StringReplaceAll', 'quotes', 'Quotes',
  'encode', 'Encode', 'decode', 'Decode', 'base64encode', 'Base64Encode', 'base64decode', 'Base64Decode',
  'booleantostring', 'BooleanToString', 'listtostring', 'ListToString', 'dateformat', 'DateFormat',
  'formatdatenow', 'FormatDateNow', 'first', 'First', 'last', 'Last', 'getvaluefrommap', 'GetValueFromMap',
  'name', 'Name', 'xmlencode', 'XmlEncode', 'xmldecode', 'XmlDecode', 'format', 'Format', 'getvalue', 'GetValue');
helpers(CsType.Int,
  'stringindexof', 'StringIndexOf', 'stringlastindexof', 'StringLastIndexOf', 'find', 'Find', 'datecompare', 'DateCompare');
helpers(CsType.Long,
  'datediff', 'DateDiff', 'datediffdays', 'DateDiffDays', 'datediffhours', 'DateDiffHours',
  'datediffminutes', 'DateDiffMinutes', 'datetoseconds', 'DateToSeconds');
helpers(CsType.Double,
  'round', 'Round', 'min', 'Min', 'max', 'Max', 'sum', 'Sum', 'average', 'Average',
  'ceiling', 'Ceiling', 'floor', 'Floor', 'sqrt', 'Sqrt', 'random', 'Random');
helpers(CsType.Bool,
  'match2', 'Match2', 'containskey', 'ContainsKey', 'containsvalue', 'ContainsValue',
  'stringtoboolean', 'ToBool', 'datebetween', 'DateBetween', 'match', 'Match');
helpers(CsType.List,
  'list', 'List', 'stringtolist', 'StringToList', 'stringtolistwithlimit', 'StringToListWithLimit',
  'append', 'Append', 'insert', 'Insert', 'set', 'Set', 'remove', 'Remove', 'keys', 'Keys', 'values', 'Values',
  'getlistfromxpath', 'GetListFromXPath', 'sort', 'Sort');
helpers(CsType.Map,
  'map', 'Map', 'put', 'Put', 'liststomap', 'ListsToMap', 'getmapfromxpath', 'GetMapFromXPath');
helpers(CsType.DateTime,
  'dateaddseconds', 'DateAddSeconds', 'dateaddminutes', 'DateAddMinutes', 'dateaddhours', 'DateAddHours',
  'dateadddays', 'DateAddDays', 'dateaddmonths', 'DateAddMonths', 'dateaddyears', 'DateAddYears',
  'converttimezone', 'ConvertTimeZone', 'converttimezone2', 'ConvertTimeZone2',
  'datefromxmlformat', 'ToDateTime', 'datefromseconds', 'DateFromSeconds',
  'monthstart', 'MonthStart', 'monthend', 'MonthEnd', 'yearstart', 'YearStart', 'yearend', 'YearEnd');
helpers(CsType.Int,
  'year', 'Year', 'month', 'Month', 'day', 'Day', 'hour', 'Hour', 'minute', 'Minute', 'second', 'Second',
  'dayofweek', 'DayOfWeek', 'dayofyear', 'DayOfYear', 'daysinmonth', 'DaysInMonth');
helpers(CsType.Double,
  'exp', 'Exp', 'ln', 'Ln', 'log', 'Log', 'logn', 'LogN', 'sin', 'Sin', 'cos', 'Cos', 'tan', 'Tan',
  'asin', 'Asin', 'acos', 'Acos', 'atan', 'Atan', 'sinh', 'Sinh', 'cosh', 'Cosh', 'tanh', 'Tanh');
helpers(CsType.String,
  'getsessionvariable', 'GetSessionVariable', 'datetoxmlformat', 'DateToXmlFormat');

/** symbols: { resolve(reference) -> TypedCode | null, note(message), transactionPath, newName(wanted) } */
export class ExpressionTranslator {
  constructor(symbols) {
    this._symbols = symbols;
  }

  /** Translates an expression text; one that cannot be parsed becomes Mii.Unparsed(...) and a note. */
  translate(expression) {
    if (expression != null && expression.trim() === '<<REMOVE>>') {
      return TypedCode.primary('null', CsType.Object); // the marker of a Remove XML link, no value
    }

    let node;

    try {
      node = parseExpression(expression);
    } catch (error) {
      if (!(error instanceof ExpressionError)) {
        throw error;
      }

      this._symbols.note('expression not understood (' + error.message + '): ' + oneLine(expression));
      return TypedCode.primary('Mii.Unparsed(' + CsLiteral.string(expression) + ')', CsType.Object);
    }

    // MII documents only the escapes \\ and \" (\r, \n and \t run); another one such as \[ makes the expression fail
    for (const text of (expression || '').match(/"(?:[^"\\]|\\.)*"/g) || []) {
      const escape = (text.match(/\\./g) || []).find((pair) => !['\\\\', '\\"', '\\r', '\\n', '\\t'].includes(pair));

      if (escape) {
        this._symbols.note('string literal with the escape ' + escape + ' (MII knows \\\\ and \\"; the expression does not compile in MII): ' + oneLine(expression));
        break;
      }
    }

    return this.translateNode(node);
  }

  translateNode(node) {
    switch (node.node) {
      case 'Empty': return literal('""', CsType.String, '');
      case 'String': return literal(CsLiteral.string(node.value), CsType.String, node.value);
      case 'Number': return numberLiteral(node.text);
      case 'Boolean': return literal(node.value ? 'true' : 'false', CsType.Bool, node.value ? 'true' : 'false');
      case 'Keyword': return this._keyword(node.name);
      case 'Reference': return this._reference(node);
      case 'Function': return this._function(node);
      case 'Unary': return this._unary(node);
      case 'Binary': return this._binary(node);
      case 'Dynamic': {
        const inner = this.translate(node.text);
        this._symbols.note('#...# evaluates text as an expression at runtime (not translatable): #' + node.text + '#');
        return TypedCode.primary('Mii.Evaluate(' + toStringCode(inner).code + ')', CsType.Object);
      }
      case 'ListLiteral': return TypedCode.primary(ValueLiteral.listCode(node.text), CsType.List);
      default: throw new Error('unknown node ' + node.node);
    }
  }

  unresolved(what) {
    return TypedCode.primary('Mii.Unresolved(' + CsLiteral.string(what) + ')', CsType.Object);
  }

  _keyword(name) {
    switch (name) {
      case 'cr': return literal('"\\r"', CsType.String, '\r');
      case 'lf': return literal('"\\n"', CsType.String, '\n');
      case 'crlf': return literal('"\\r\\n"', CsType.String, '\r\n');
      case 'tab': return literal('"\\t"', CsType.String, '\t');
      case 'doublequote': return literal('"\\""', CsType.String, '"');
      case 'singlequote': return literal('"\'"', CsType.String, "'");
      case 'datenow': return TypedCode.primary('DateTime.Now', CsType.DateTime);
      case 'today': return TypedCode.primary('DateTime.Today', CsType.DateTime);
      case 'dateformat': return literal('"yyyy-MM-dd\'T\'HH:mm:ss"', CsType.String, "yyyy-MM-dd'T'HH:mm:ss");
      case 'dateoffsetformat': return literal('"yyyy-MM-dd\'T\'HH:mm:ssZ"', CsType.String, "yyyy-MM-dd'T'HH:mm:ssZ");
      case 'datetimezoneformat': return literal('"yyyy-MM-dd\'T\'HH:mm:ssz"', CsType.String, "yyyy-MM-dd'T'HH:mm:ssz");
      case 'currenttimezone': return TypedCode.primary('TimeZoneInfo.Local.Id', CsType.String);
      case 'currenttimeoffset':
        this._symbols.note('currenttimeoffset does not exist in MII (currenttimezoneoffset is the offset in milliseconds)');
        return this.unresolved(name);
      case 'timezoneids': return TypedCode.primary('Mii.TimeZoneIds()', CsType.List);
      case 'emptylist': return TypedCode.primary('new List<string>()', CsType.List);
      case 'emptymap': return TypedCode.primary('new Dictionary<string, string>()', CsType.Map);
      case 'nullstring': return literal('""', CsType.String, '');
      case 'nulldate': return TypedCode.primary('DateTime.MinValue', CsType.DateTime);
      case 'nullnumber': return TypedCode.primary('double.NaN', CsType.Double);
      case 'guid': return TypedCode.primary('Guid.NewGuid().ToString()', CsType.String);
      case 'transactionid': return TypedCode.primary('Mii.TransactionId', CsType.String);
      case 'e': return TypedCode.primary('Math.E', CsType.Double);
      case 'pi': return TypedCode.primary('Math.PI', CsType.Double);
      case 'username': return TypedCode.primary('Mii.UserName', CsType.String);
      case 'transactionpath': return literal(CsLiteral.string(this._symbols.transactionPath), CsType.String, this._symbols.transactionPath);
      case 'currenttimemillis': return TypedCode.primary('Mii.CurrentTimeMillis()', CsType.Long);
      case 'userlocale': return TypedCode.primary('Mii.UserLocale', CsType.String);
      case 'currenttimezoneoffset': return TypedCode.primary('Mii.CurrentTimeZoneOffset()', CsType.Long);
      default: return this.unresolved(name);
    }
  }

  // ------------------------------------------------------------------------------------------ references, selectors

  _reference(reference) {
    let baseCode = this._symbols.resolve(reference);

    if (baseCode === null) {
      this._symbols.note('unknown reference ' + reference.path);
      baseCode = this.unresolved(reference.path);
    }

    if (reference.selector === null) {
      if (baseCode.type.contract) {
        baseCode.type.contract.passedOnWhole = true;
      }

      return baseCode;
    }

    return this.applySelector(baseCode, reference.selector);
  }

  /** {xpath} on XML, {key} on a map, {index} on a list. Rowset XPaths of the usual forms become typed access. */
  applySelector(baseCode, selector) {
    let trimmed = selector.trim();

    // Map{"Key"} is the documented form of a map key; the quotes are not part of the key
    if (/^"[^"]*"$/.test(trimmed) && baseCode.type.kind !== TypeKind.Xml && baseCode.type.kind !== TypeKind.Rowset && baseCode.type.kind !== TypeKind.Row) {
      trimmed = trimmed.substring(1, trimmed.length - 1);
    }

    if (trimmed.includes('#')) {
      return xpathCall(baseCode, this._interpolatedText(trimmed).code);
    }

    const pathLiteral = CsLiteral.string(trimmed);

    switch (baseCode.type.kind) {
      case TypeKind.Map:
        return TypedCode.primary('Mii.MapGet(' + baseCode.code + ', ' + pathLiteral + ')', CsType.String);
      case TypeKind.List:
        if (INDEX.test(trimmed)) {
          return TypedCode.primary('Mii.ListGet(' + baseCode.code + ', ' + trimmed + ')', CsType.String);
        }

        break;
      case TypeKind.Rowset: {
        const typed = this._rowsetSelector(baseCode, trimmed);

        if (typed !== null) {
          return typed;
        }

        break;
      }
      case TypeKind.Row: {
        const single = SINGLE_ROW_COLUMN.exec(trimmed);

        if (single) {
          return columnAccess(baseCode.at(Precedence.Primary), baseCode.type.contract, single[1], baseCode, pathLiteral);
        }

        if (trimmed === '/Row' || trimmed === 'Row') {
          return baseCode;
        }

        break;
      }
      case TypeKind.Xml:
        return xpathCall(baseCode, pathLiteral);
      default:
        break;
    }

    if (WORD.test(trimmed) && baseCode.type.kind !== TypeKind.Rowset && baseCode.type.kind !== TypeKind.Row) {
      // a key on something of unknown type: map lookup or XPath, decided at runtime
      const result = TypedCode.primary('Mii.Select(' + baseCode.code + ', ' + pathLiteral + ')', CsType.String);
      result.xmlCode = 'Mii.SelectXml(' + baseCode.code + ', ' + pathLiteral + ')';
      return result;
    }

    return xpathCall(baseCode, pathLiteral);
  }

  _rowsetSelector(baseCode, path) {
    const target = baseCode.at(Precedence.Primary);
    const pathLiteral = CsLiteral.string(path);
    const contract = baseCode.type.contract;
    let match = ROW_COLUMN.exec(path);

    if (match) {
      return columnAccess(target + '.FirstOrEmpty()', contract, match[1], baseCode, pathLiteral);
    }

    match = INDEXED_ROW_COLUMN.exec(path);

    if (match) {
      return columnAccess(target + '.RowAt(' + match[1] + ')', contract, match[2], baseCode, pathLiteral);
    }

    match = FILTERED_ROW_COLUMN.exec(path);

    if (match) {
      const filter = contract.ensure(match[1]);
      filter.read = true;
      const parameter = this._symbols.newName('row');
      const column = parameter + '.' + filter.propertyName;
      const condition = (filter.type.kind === TypeKind.String ? column : 'Mii.ToStr(' + column + ')') + ' == ' + CsLiteral.string(match[2]);
      return columnAccess(target + '.FirstOrEmpty(' + parameter + ' => ' + condition + ')', contract, match[3], baseCode, pathLiteral);
    }

    return ROW_COUNT.test(path) ? TypedCode.primary(target + '.Count', CsType.Int) : null;
  }

  /** The XPath of a selector as C#: a literal, or a concatenation when it contains #expr# parts. */
  selectorPathCode(selector) {
    const trimmed = selector.trim();
    return trimmed.includes('#') ? this._interpolatedText(trimmed).code : CsLiteral.string(trimmed);
  }

  _interpolatedText(text) {
    const parts = [];
    let position = 0;

    while (position < text.length) {
      const open = text.indexOf('#', position);
      const close = open < 0 ? -1 : text.indexOf('#', open + 1);

      if (open < 0 || close < 0) {
        parts.push(CsLiteral.string(text.substring(position)));
        break;
      }

      if (open > position) {
        parts.push(CsLiteral.string(text.substring(position, open)));
      }

      parts.push(toStringCode(this.translate(text.substring(open + 1, close))).at(Precedence.Additive + 1));
      position = close + 1;
    }

    if (parts.length === 0) {
      return literal('""', CsType.String, '');
    }

    return new TypedCode(parts.join(' + '), CsType.String, parts.length === 1 ? Precedence.Primary : Precedence.Additive);
  }

  // ------------------------------------------------------------------------------------------ operators

  _unary(unary) {
    const operand = this.translateNode(unary.operand);

    if (unary.operator === '!') {
      return new TypedCode('!' + toBoolCode(operand).at(Precedence.Unary), CsType.Bool, Precedence.Unary);
    }

    const numeric = toNumericCode(operand);
    return new TypedCode('-' + numeric.at(Precedence.Unary), numeric.type, Precedence.Unary);
  }

  _binary(binary) {
    if (binary.operator === '&') {
      return this._concatenation(binary);
    }

    const left = this.translateNode(binary.left);
    const right = this.translateNode(binary.right);

    switch (binary.operator) {
      case '+':
      case '-':
      case '*':
      case '/':
      case '%':
        return arithmetic(binary.operator, left, right);
      case '^':
        return TypedCode.primary('Math.Pow(' + toDoubleCode(left).code + ', ' + toDoubleCode(right).code + ')', CsType.Double);
      case '<':
      case '>':
      case '<=':
      case '>=':
        return relational(binary.operator, left, right);
      case '==':
      case '!=':
        return equality(binary.operator, left, right);
      // MII evaluates both sides of && and ||: C#'s & and | on bools do the same, && and || would not
      case '&&':
        return new TypedCode(toBoolCode(left).at(Precedence.BitwiseAnd) + ' & ' + toBoolCode(right).at(Precedence.BitwiseAnd + 1), CsType.Bool, Precedence.BitwiseAnd);
      case '||':
        return new TypedCode(toBoolCode(left).at(Precedence.BitwiseOr) + ' | ' + toBoolCode(right).at(Precedence.BitwiseOr + 1), CsType.Bool, Precedence.BitwiseOr);
      default:
        throw new Error('unknown operator ' + binary.operator);
    }
  }

  /** a & b & c: every part as string; empty string literals are dropped; text and values as interpolation. */
  _concatenation(binary) {
    const operands = [];
    flatten(binary, operands);
    const parts = [];
    let afterString = false;

    for (const operand of operands) {
      const translated = this.translateNode(operand);
      // C# turns an int or long into text by itself once a string stands before it: "0" + count
      const native = afterString && (translated.type.kind === TypeKind.Int || translated.type.kind === TypeKind.Long);
      const part = native ? translated : toStringCode(translated);
      afterString = afterString || part.type.kind === TypeKind.String;

      if (!(part.isLiteral && part.literalText.length === 0)) {
        parts.push(part);
      }
    }

    if (parts.length === 0) {
      return literal('""', CsType.String, '');
    }

    return parts.length === 1 ? parts[0] : interpolation(parts);
  }

  // ------------------------------------------------------------------------------------------ functions

  _function(fn) {
    const args = fn.args;

    switch (fn.name) {
      case 'stringlength':
        if (args.length === 1) {
          return TypedCode.primary(this._stringArgument(args[0]) + '.Length', CsType.Int);
        }

        break;
      case 'stringupper':
        if (args.length === 1) {
          return TypedCode.primary(this._stringArgument(args[0]) + '.ToUpperInvariant()', CsType.String);
        }

        break;
      case 'stringlower':
        if (args.length === 1) {
          return TypedCode.primary(this._stringArgument(args[0]) + '.ToLowerInvariant()', CsType.String);
        }

        break;
      case 'stringtrim':
        if (args.length === 1) {
          return TypedCode.primary(this._stringArgument(args[0]) + '.Trim()', CsType.String);
        }

        break;
      case 'match':
        if (args.length === 2) {
          const idiom = this._matchIdiom(args);

          if (idiom !== null) {
            return idiom;
          }

          // case-sensitive on the system unless the pattern carries (?i)
          return TypedCode.primary('Regex.IsMatch(' + toStringCode(this.translateNode(args[0])).code + ', ' + toStringCode(this.translateNode(args[1])).code + ')', CsType.Bool);
        }

        break;
      case 'stringif':
        if (args.length === 3) {
          return new TypedCode(toBoolCode(this.translateNode(args[0])).at(Precedence.Conditional + 1) + ' ? '
            + toStringCode(this.translateNode(args[1])).at(Precedence.Conditional + 1) + ' : '
            + toStringCode(this.translateNode(args[2])).at(Precedence.Conditional), CsType.String, Precedence.Conditional);
        }

        break;
      case 'if':
      case 'objectif':
        if (args.length === 3) {
          return fn.name === 'if' ? this._numericConditional(args) : this._conditional(args);
        }

        break;
      case 'not':
        if (args.length === 1) {
          return new TypedCode('!' + toBoolCode(this.translateNode(args[0])).at(Precedence.Unary), CsType.Bool, Precedence.Unary);
        }

        break;
      case 'and':
      case 'or':
        if (args.length >= 2) {
          const op = fn.name === 'and' ? ' & ' : ' | ';
          const precedence = fn.name === 'and' ? Precedence.BitwiseAnd : Precedence.BitwiseOr;
          const parts = args.map((argument) => toBoolCode(this.translateNode(argument)).at(precedence + 1));
          return new TypedCode(parts.join(op), CsType.Bool, precedence);
        }

        break;
      case 'number':
        if (args.length === 1) {
          const count = this._zeroPrefixedNumber(args[0]);

          if (count !== null) {
            return count;
          }

          // number() converts strictly: empty or other text fails in MII
          const value = this.translateNode(args[0]);
          return value.type.isNumeric ? toDoubleCode(value) : call('Mii.Number', value, CsType.Double);
        }

        break;
      case 'datefromxmlformat':
        if (args.length === 2) {
          return TypedCode.primary('Mii.DateFromXmlFormat(' + this.translateNode(args[0]).code + ', ' + this.translateNode(args[1]).code + ')', CsType.String);
        }

        break;
      case 'remove':
        if (args.length === 2) {
          const collection = this.translateNode(args[0]);

          if (collection.type.kind === TypeKind.Map) {
            return TypedCode.primary('Mii.RemoveKey(' + collection.code + ', ' + this.translateNode(args[1]).code + ')', CsType.Map);
          }
        }

        break;
      case 'abs':
        if (args.length === 1) {
          return TypedCode.primary('Math.Abs(' + toDoubleCode(this.translateNode(args[0])).code + ')', CsType.Double);
        }

        break;
      case 'size':
        if (args.length === 1) {
          const collection = this.translateNode(args[0]);

          if (collection.type.kind === TypeKind.List || collection.type.kind === TypeKind.Map) {
            return TypedCode.primary(collection.at(Precedence.Primary) + '.Count', CsType.Int);
          }

          return TypedCode.primary('Mii.Size(' + collection.code + ')', CsType.Int);
        }

        break;
      case 'getvalue':
        if (args.length === 1) {
          const resolved = this._getValueOfCatchSource(args[0]);

          if (resolved) {
            return resolved;
          }

          this._symbols.note('getvalue() reads a property by a name built at runtime (not translatable)');
        }

        break;
      default:
        break;
    }

    return this._helperCall(fn);
  }

  /** match(x, empty pattern) is Mii.IsEmpty(x), match(x, boolean pattern) is Mii.IsTrue(x); only these exact patterns. */
  _matchIdiom(args) {
    const pattern = args[1];

    if (pattern.node !== 'String') {
      return null;
    }

    let method = null;

    if (EMPTY_PATTERNS.includes(pattern.value)) {
      method = 'Mii.IsEmpty';
    } else if (pattern.value === TRUE_PATTERN) {
      method = 'Mii.IsTrue';
    }

    return method === null ? null : TypedCode.primary(method + '(' + this.translateNode(args[0]).code + ')', CsType.Bool);
  }

  /** number("0" & n) guards against an empty value; for a whole number n it is n itself. */
  _zeroPrefixedNumber(argument) {
    if (argument.node !== 'Binary' || argument.operator !== '&' || argument.left.node !== 'String' || argument.left.value !== '0') {
      return null;
    }

    const value = this.translateNode(argument.right);
    return value.type.kind === TypeKind.Int || value.type.kind === TypeKind.Long ? value : null;
  }

  _stringArgument(argument) {
    return toStringCode(this.translateNode(argument)).at(Precedence.Primary);
  }

  _conditional(args) {
    const condition = toBoolCode(this.translateNode(args[0]));
    let whenTrue = this.translateNode(args[1]);
    const whenFalse = this.translateNode(args[2]);
    let type = whenTrue.type;

    if (!whenTrue.type.isSameAs(whenFalse.type)) {
      type = CsType.Object;
      whenTrue = new TypedCode('(object)' + whenTrue.at(Precedence.Unary), CsType.Object, Precedence.Unary);
    }

    return new TypedCode(condition.at(Precedence.Conditional + 1) + ' ? ' + whenTrue.at(Precedence.Conditional + 1) + ' : ' + whenFalse.at(Precedence.Conditional), type, Precedence.Conditional);
  }

  /** if() returns a number in MII, also for text branches: text gives 0 when assigned to a string and a type cast error
   * inside a string function. Number branches stay a C# conditional; text branches become Mii.If (a double). */
  _numericConditional(args) {
    const whenTrue = this.translateNode(args[1]);
    const whenFalse = this.translateNode(args[2]);

    if (whenTrue.type.kind !== TypeKind.String && whenFalse.type.kind !== TypeKind.String) {
      return this._conditional(args);
    }

    this._symbols.note('if() with a text branch returns a number in MII (0 for text, a type cast error inside a string function); stringif() returns text');
    return TypedCode.primary('Mii.If(' + toBoolCode(this.translateNode(args[0])).code + ', ' + whenTrue.code + ', ' + whenFalse.code + ')', CsType.Double);
  }

  /** getvalue(CatchX.Source & ".Message"): the caught exception's message. */
  _getValueOfCatchSource(argument) {
    if (argument.node !== 'Binary' || argument.operator !== '&') {
      return null;
    }

    const source = argument.left;
    const suffix = argument.right;

    if (source.node !== 'Reference' || suffix.node !== 'String' || source.selector !== null || !source.path.endsWith('.Source') || suffix.value !== '.Message') {
      return null;
    }

    return this._symbols.resolve({ node: 'Reference', path: referenceScope(source) + '.Message', selector: null });
  }

  _helperCall(fn) {
    const args = fn.args.map((argument) => this.translateNode(argument).code);
    const helper = HELPERS.get(fn.name);

    if (helper) {
      return TypedCode.primary(helper.method + '(' + args.join(', ') + ')', helper.returnType);
    }

    this._symbols.note('MII function ' + fn.name + '() has no X-Ray equivalent; Mii.Function throws NotImplementedException');
    args.unshift(CsLiteral.string(fn.name));
    return TypedCode.primary('Mii.Function(' + args.join(', ') + ')', CsType.Object);
  }
}

function numberLiteral(text) {
  if (/^\d+$/.test(text)) {
    const value = BigInt(text);

    if (value <= 2147483647n) {
      return literal(value.toString(), CsType.Int, text);
    }

    if (value <= 9223372036854775807n) {
      return literal(value.toString() + 'L', CsType.Long, text);
    }
  }

  return literal(CsLiteral.number(text, TypeKind.Double), CsType.Double, text);
}

function xpathCall(baseCode, pathCode) {
  const result = TypedCode.primary('Mii.XPath(' + baseCode.code + ', ' + pathCode + ')', CsType.String);
  result.xmlCode = 'Mii.SelectXml(' + baseCode.code + ', ' + pathCode + ')';
  return result;
}

function columnAccess(row, contract, columnName, baseCode, pathLiteral) {
  const column = contract.ensure(columnName);
  column.read = true;
  const result = TypedCode.primary(row + '.' + column.propertyName, column.type);
  result.xmlCode = 'Mii.SelectXml(' + baseCode.code + ', ' + pathLiteral + ')';
  return result;
}

function flatten(node, operands) {
  if (node.node === 'Binary' && node.operator === '&') {
    flatten(node.left, operands);
    flatten(node.right, operands);
    return;
  }

  operands.push(node);
}

/** Text parts and values as an interpolated string: $"The site \"{site}\" is invalid"; values only as +. */
function interpolation(parts) {
  const hasText = parts.some((part) => part.isLiteral && part.type.kind === TypeKind.String);

  if (!hasText) {
    return new TypedCode(parts.map((part) => part.at(Precedence.Additive + 1)).join(' + '), CsType.String, Precedence.Additive);
  }

  let text = '$"';

  for (const part of parts) {
    text += part.isLiteral && part.type.kind === TypeKind.String
      ? CsLiteral.interpolatedText(part.literalText)
      : '{' + part.at(Precedence.Conditional + 1) + '}';
  }

  return TypedCode.primary(text + '"', CsType.String);
}

function arithmetic(op, left, right) {
  let type = commonNumericType(left.type, right.type);
  let a;

  if (op === '/' && (type.kind === TypeKind.Int || type.kind === TypeKind.Long)) {
    type = CsType.Double; // MII divides as floating point, C# would divide integers
    a = new TypedCode('(double)' + left.at(Precedence.Unary), CsType.Double, Precedence.Unary);
  } else {
    a = toNumberOf(left, type);
  }

  const b = toNumberOf(right, type);
  const precedence = op === '+' || op === '-' ? Precedence.Additive : Precedence.Multiplicative;
  return new TypedCode(a.at(precedence) + ' ' + op + ' ' + b.at(precedence + 1), type, precedence);
}

function relational(op, left, right) {
  if (isNumericOrUnknownNumber(left, right)) {
    const type = commonNumericType(left.type, right.type);
    return new TypedCode(toNumberOf(left, type).at(Precedence.Relational + 1) + ' ' + op + ' ' + toNumberOf(right, type).at(Precedence.Relational + 1), CsType.Bool, Precedence.Relational);
  }

  if (left.type.kind === TypeKind.DateTime && right.type.kind === TypeKind.DateTime) {
    return new TypedCode(left.at(Precedence.Relational + 1) + ' ' + op + ' ' + right.at(Precedence.Relational + 1), CsType.Bool, Precedence.Relational);
  }

  return new TypedCode('Mii.Compare(' + left.code + ', ' + right.code + ') ' + op + ' 0', CsType.Bool, Precedence.Relational);
}

function isNumericOrUnknownNumber(left, right) {
  return (left.type.isNumeric && right.type.isNumeric)
    || (left.type.isNumeric && right.type.kind !== TypeKind.String && right.type.kind !== TypeKind.DateTime)
    || (right.type.isNumeric && left.type.kind !== TypeKind.String && left.type.kind !== TypeKind.DateTime);
}

function equality(op, left, right) {
  const same = (left.type.kind === TypeKind.String && right.type.kind === TypeKind.String)
    || (left.type.kind === TypeKind.Bool && right.type.kind === TypeKind.Bool)
    || (left.type.kind === TypeKind.DateTime && right.type.kind === TypeKind.DateTime);

  if (same) {
    return new TypedCode(left.at(Precedence.Equality + 1) + ' ' + op + ' ' + right.at(Precedence.Equality + 1), CsType.Bool, Precedence.Equality);
  }

  if (left.type.isNumeric && right.type.isNumeric) {
    const type = commonNumericType(left.type, right.type);
    return new TypedCode(toNumberOf(left, type).at(Precedence.Equality + 1) + ' ' + op + ' ' + toNumberOf(right, type).at(Precedence.Equality + 1), CsType.Bool, Precedence.Equality);
  }

  const callCode = 'Mii.AreEqual(' + left.code + ', ' + right.code + ')';
  return op === '==' ? TypedCode.primary(callCode, CsType.Bool) : new TypedCode('!' + callCode, CsType.Bool, Precedence.Unary);
}

function oneLine(text) {
  const value = (text || '').replace(/\r/g, ' ').replace(/\n/g, ' ');
  return value.length > 120 ? value.substring(0, 120) + '...' : value;
}
