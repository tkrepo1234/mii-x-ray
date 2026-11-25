// C# types, identifiers and literals of the generated code.

export const TypeKind = {
  String: 'String', Bool: 'Bool', Int: 'Int', Long: 'Long', Double: 'Double', Decimal: 'Decimal', DateTime: 'DateTime',
  List: 'List', Map: 'Map', Xml: 'Xml', Rowset: 'Rowset', Row: 'Row', Class: 'Class', Object: 'Object',
};

/** The C# type of a generated value. */
export class CsType {
  constructor(kind, name, contract) {
    this.kind = kind;
    this._name = name;
    this.contract = contract || null;
  }

  static rowsetOf(contract) {
    return new CsType(TypeKind.Rowset, null, contract);
  }

  static rowOf(contract) {
    return new CsType(TypeKind.Row, null, contract);
  }

  static class(name) {
    return new CsType(TypeKind.Class, name, null);
  }

  get name() {
    if (this.contract) {
      return this.kind === TypeKind.Row ? this.contract.rowTypeName : this.contract.rowsetTypeName;
    }

    return this._name;
  }

  get isNumeric() {
    return this.kind === TypeKind.Int || this.kind === TypeKind.Long || this.kind === TypeKind.Double || this.kind === TypeKind.Decimal;
  }

  isSameAs(other) {
    if (!other || other.kind !== this.kind) {
      return false;
    }

    if (this.contract || other.contract) {
      return this.contract === other.contract;
    }

    return this._name === other._name;
  }
}

CsType.String = new CsType(TypeKind.String, 'string');
CsType.Bool = new CsType(TypeKind.Bool, 'bool');
CsType.Int = new CsType(TypeKind.Int, 'int');
CsType.Long = new CsType(TypeKind.Long, 'long');
CsType.Double = new CsType(TypeKind.Double, 'double');
CsType.Decimal = new CsType(TypeKind.Decimal, 'decimal');
CsType.DateTime = new CsType(TypeKind.DateTime, 'DateTime');
CsType.List = new CsType(TypeKind.List, 'List<string>');
CsType.Map = new CsType(TypeKind.Map, 'Dictionary<string, string>');
CsType.Xml = new CsType(TypeKind.Xml, 'XmlDocument');
CsType.Object = new CsType(TypeKind.Object, 'object');

/** C# operator precedence levels (higher binds tighter). */
export const Precedence = {
  Conditional: 3, LogicalOr: 5, LogicalAnd: 6, BitwiseOr: 7, BitwiseAnd: 9, Equality: 10, Relational: 11, Additive: 13, Multiplicative: 14, Unary: 15, Primary: 16,
};

/** A translated C# expression with its type. */
export class TypedCode {
  constructor(code, type, precedence) {
    this.code = code;
    this.type = type;
    this.precedence = precedence;
    this.xmlCode = null; // an alternative that yields an XmlDocument (XPath selections used as XML)
    this.isLiteral = false;
    this.literalText = null;
  }

  static primary(code, type) {
    return new TypedCode(code, type, Precedence.Primary);
  }

  /** The code, in parentheses when it binds weaker than the given precedence. */
  at(precedence) {
    return this.precedence < precedence ? '(' + this.code + ')' : this.code;
  }
}

// ---------------------------------------------------------------------------------------------- names

const KEYWORDS = new Set([
  'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked', 'class', 'const', 'continue',
  'decimal', 'default', 'delegate', 'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern', 'false', 'finally',
  'fixed', 'float', 'for', 'foreach', 'goto', 'if', 'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock',
  'long', 'namespace', 'new', 'null', 'object', 'operator', 'out', 'override', 'params', 'private', 'protected',
  'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed', 'short', 'sizeof', 'stackalloc', 'static', 'string',
  'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong', 'unchecked', 'unsafe', 'ushort',
  'using', 'virtual', 'void', 'volatile', 'while',
]);

const LETTER_OR_DIGIT = /[\p{L}\p{Nd}]/u;
const DIGIT = /\p{Nd}/u;
const UPPER = /\p{Lu}/u;

/** C# identifiers from MII names. */
export const Naming = {
  /** Letters, digits and underscores only; never starts with a digit; never empty. */
  sanitize(name) {
    let result = '';
    let upperNext = false;

    for (const c of name || '') {
      if (LETTER_OR_DIGIT.test(c) || c === '_') {
        result += upperNext ? c.toUpperCase() : c;
        upperNext = false;
      } else {
        upperNext = result.length > 0;
      }
    }

    if (result.length === 0) {
      result = 'Value';
    }

    return DIGIT.test(result[0]) ? '_' + result : result;
  },

  isValidIdentifier(name) {
    return !!name && Naming.sanitize(name) === name && !KEYWORDS.has(name);
  },

  pascal(name) {
    const clean = Naming.sanitize(name);
    const result = clean[0].toUpperCase() + clean.substring(1);
    return KEYWORDS.has(result) ? '@' + result : result;
  },

  camel(name) {
    const clean = Naming.sanitize(name);
    let upper = 0;

    while (upper < clean.length && UPPER.test(clean[upper])) {
      upper++;
    }

    let result;

    if (upper <= 1) {
      result = clean[0].toLowerCase() + clean.substring(1);
    } else if (upper === clean.length) {
      result = clean.toLowerCase();
    } else {
      result = clean.substring(0, upper - 1).toLowerCase() + clean.substring(upper - 1); // "SFCNumber" -> "sfcNumber"
    }

    return KEYWORDS.has(result) ? result + 'Value' : result;
  },
};

/** Hands out unique names inside one C# scope. */
export class UniqueNames {
  constructor() {
    this._used = new Set();
  }

  reserve(name) {
    this._used.add(name);
  }

  isUsed(name) {
    return this._used.has(name);
  }

  claim(wanted) {
    let name = wanted;
    let counter = 2;

    while (this._used.has(name)) {
      name = wanted + counter;
      counter++;
    }

    this._used.add(name);
    return name;
  }
}

// ---------------------------------------------------------------------------------------------- default values

/** Default values larger than this (UTF-8 bytes) are not written into the file. */
export const DEFAULT_LIMIT = 131072;

/** The MII default as written into the file: the value, or "[n-bytes]" when it is larger than DEFAULT_LIMIT. */
export function limitedDefault(text) {
  const value = text || '';

  if (value.length * 3 <= DEFAULT_LIMIT) {
    return value;
  }

  const bytes = new TextEncoder().encode(value).length;
  return bytes > DEFAULT_LIMIT ? '[' + bytes + '-bytes]' : value;
}

export const isOmittedDefault = (text) => /^\[\d+-bytes\]$/.test(text || '');

// ---------------------------------------------------------------------------------------------- literals

const isControl = (c) => {
  const code = c.charCodeAt(0);
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
};

export const CsLiteral = {
  /** A raw string literal for multi-line text, a one-line raw literal for text with quotes (XML), a verbatim
   * literal (@"...") for text with backslashes (regular expressions), else a regular literal. */
  string(value) {
    if (value == null) {
      return 'null';
    }

    if ([...value].some((c) => isControl(c) && c !== '\r' && c !== '\n' && c !== '\t')) {
      return regular(value);
    }

    if (value.includes('\n') || value.includes('\r')) {
      // a short text with a line break or two (a literal with \r\n) stays one exact line; documents are raw literals
      return value.length <= 120 && value.split(/\r\n|\r|\n/).length <= 3 ? regular(value) : raw(value);
    }

    if (value.includes('"') && !value.includes('"""') && !value.startsWith('"') && !value.endsWith('"') && !value.includes('\t')) {
      return '"""' + value + '"""';
    }

    if (value.includes('\\') && !value.includes('\t')) {
      return '@"' + value.replace(/"/g, '""') + '"';
    }

    return regular(value);
  },

  /** The text of an interpolated string part: escaped like a regular literal, braces doubled. */
  interpolatedText(value) {
    const literal = regular(value);
    return literal.substring(1, literal.length - 1).replace(/\{/g, '{{').replace(/\}/g, '}}');
  },

  /** A number literal of the given kind from MII text; 0 when the text is no number. */
  number(text, kind) {
    const trimmed = (text || '').trim();
    let value = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed) ? Number(trimmed) : 0;

    if (!Number.isFinite(value)) {
      value = 0;
    }

    switch (kind) {
      case TypeKind.Int:
        return value >= -2147483648 && value <= 2147483647 ? String(Math.trunc(value)) : '0';
      case TypeKind.Long:
        if (/^[+-]?\d+$/.test(trimmed)) {
          const parsed = BigInt(trimmed);

          if (parsed >= -9223372036854775808n && parsed <= 9223372036854775807n) {
            return parsed.toString() + 'L';
          }
        }

        return value >= -9223372036854775808 && value <= 9223372036854775807 ? BigInt(Math.trunc(value)).toString() + 'L' : '0L';
      case TypeKind.Decimal:
        return roundTrip(value) + 'm';
      default: {
        const result = roundTrip(value);
        return result.includes('.') || result.includes('E') ? result : result + '.0';
      }
    }
  },

  isTrue(text) {
    const trimmed = (text || '').trim();
    return trimmed.toLowerCase() === 'true' || trimmed === '1';
  },

  /** new DateTime(...) for an MII date (yyyy-MM-ddTHH:mm:ss); DateTime.MinValue when empty or unreadable. */
  dateTimeValue(text) {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3}|Z|[+-]\d{2}:\d{2})?)?$/.exec((text || '').trim());

    if (!match) {
      return 'DateTime.MinValue';
    }

    const [year, month, day] = [match[1], match[2], match[3]].map(Number);
    const [hour, minute, second] = [match[4] || '0', match[5] || '0', match[6] || '0'].map(Number);

    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59) {
      return 'DateTime.MinValue';
    }

    if (hour === 0 && minute === 0 && second === 0) {
      return 'new DateTime(' + year + ', ' + month + ', ' + day + ')';
    }

    return 'new DateTime(' + [year, month, day, hour, minute, second].join(', ') + ')';
  },
};

function regular(value) {
  let result = '"';

  for (const c of value) {
    switch (c) {
      case '\\': result += '\\\\'; break;
      case '"': result += '\\"'; break;
      case '\r': result += '\\r'; break;
      case '\n': result += '\\n'; break;
      case '\t': result += '\\t'; break;
      case '\0': result += '\\0'; break;
      default:
        if (isControl(c) || c === ' ' || c === ' ') {
          result += '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
        } else {
          result += c;
        }
    }
  }

  return result + '"';
}

/** """(newline)text(newline)""" - closing quotes at the start of their line, so indenting every line keeps the value. */
function raw(value) {
  const text = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let longest = 0;
  let run = 0;

  for (const c of text) {
    run = c === '"' ? run + 1 : 0;
    longest = Math.max(longest, run);
  }

  const quotes = '"'.repeat(Math.max(3, longest + 1));
  return quotes + '\n' + text + '\n' + quotes;
}

/** double.ToString("R"): the shortest round-trip form, scientific from 1E+15 and below 1E-05 as .NET writes it. */
function roundTrip(value) {
  const absolute = Math.abs(value);

  if (absolute !== 0 && (absolute >= 1e15 || absolute < 1e-5)) {
    const [mantissa, exponent] = value.toExponential().split('e');
    const sign = exponent[0] === '-' ? '-' : '+';
    return mantissa + 'E' + sign + exponent.substring(1).padStart(2, '0');
  }

  return String(value);
}

// ---------------------------------------------------------------------------------------------- list and map literals

/** MII list and map literals: [[string:a], [string:b]] and {Key=[string:value], K2=[double:1.0]}. */
export const ValueLiteral = {
  parseList(text) {
    const values = [];
    const trimmed = (text || '').trim();

    if (trimmed.length < 2 || trimmed[0] !== '[') {
      return values;
    }

    let position = 1;

    while (position < trimmed.length - 1) {
      const open = trimmed.indexOf('[', position);

      if (open < 0) {
        break;
      }

      const typed = readTypedValue(trimmed, open);
      values.push(typed.value);
      position = typed.end + 1;
    }

    return values;
  },

  parseMap(text) {
    const pairs = [];
    const trimmed = (text || '').trim();

    if (trimmed.length < 2 || trimmed[0] !== '{') {
      return pairs;
    }

    let position = 1;

    while (position < trimmed.length - 1) {
      const equals = trimmed.indexOf('=', position);

      if (equals < 0) {
        break;
      }

      const key = trimmed.substring(position, equals).trim().replace(/^,+/, '').trim();
      let open = equals + 1;

      while (open < trimmed.length && trimmed[open] === ' ') {
        open++;
      }

      if (open >= trimmed.length || trimmed[open] !== '[') {
        break;
      }

      const typed = readTypedValue(trimmed, open);
      pairs.push([key, typed.value]);
      position = typed.end + 1;
    }

    return pairs;
  },

  listCode(text) {
    const values = ValueLiteral.parseList(text);
    return values.length === 0 ? 'new List<string>()' : 'Mii.List(' + values.map(CsLiteral.string).join(', ') + ')';
  },

  mapCode(text) {
    const pairs = ValueLiteral.parseMap(text);
    return pairs.length === 0
      ? 'new Dictionary<string, string>()'
      : 'Mii.Map(' + pairs.map(([key, value]) => CsLiteral.string(key) + ', ' + CsLiteral.string(value)).join(', ') + ')';
  },
};

// "[type:value]" from the opening bracket; brackets inside the value are balanced
function readTypedValue(text, open) {
  let depth = 0;
  let position = open;

  while (position < text.length) {
    if (text[position] === '[') {
      depth++;
    } else if (text[position] === ']') {
      depth--;

      if (depth === 0) {
        break;
      }
    }

    position++;
  }

  const inner = text.substring(open + 1, Math.max(open + 1, position));
  const colon = inner.indexOf(':');
  return { value: colon >= 0 ? inner.substring(colon + 1) : inner, end: position };
}
