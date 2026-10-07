// Lexer and parser of the MII link expression language. Operator precedence as documented by SAP (guide p. 199-201),
// lowest first: equality (== !=), or (|| or), and (&& and), relational (< > <= >=), concatenation (&), additive (+ -),
// multiplicative (* / %), exponent (^), unary (- !), primary. Note: & binds tighter than comparisons and equality
// binds weakest.

export class ExpressionError extends Error {}

const OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', '&', '+', '-', '*', '/', '%', '^', '!', '<', '>', '='];

const KEYWORDS = [
  'cr', 'lf', 'crlf', 'tab', 'doublequote', 'singlequote', 'datenow', 'today', 'dateformat', 'dateoffsetformat',
  'datetimezoneformat', 'currenttimezone', 'currenttimeoffset', 'timezoneids', 'emptylist', 'emptymap', 'nullstring',
  'nulldate', 'nullnumber', 'guid', 'transactionid', 'e', 'pi', 'username', 'transactionpath', 'currenttimemillis',
  'userlocale', 'currenttimezoneoffset',
];

const isDigit = (c) => /\p{Nd}/u.test(c);
const isLetter = (c) => /\p{L}/u.test(c);
const isLetterOrDigit = (c) => /[\p{L}\p{Nd}]/u.test(c);
const isWhiteSpace = (c) => /\s/u.test(c);

function token(kind, text, position) {
  return { kind, text, position, toString: () => kind + " '" + text + "'" };
}

/** Splits an expression into tokens; selectors ({xpath}), dynamic scopes (#expr#) and list literals stay raw text. */
export function tokenize(text) {
  const source = text || '';
  const tokens = [];
  let position = 0;

  for (;;) {
    skipSpaceAndComments();

    if (position >= source.length) {
      tokens.push(token('End', '', position));
      return tokens;
    }

    tokens.push(next());
  }

  function next() {
    const start = position;
    const c = source[position];

    if (c === '"') {
      return token('String', readString(), start);
    }

    if (isDigit(c) || (c === '.' && position + 1 < source.length && isDigit(source[position + 1]))) {
      return token('Number', readNumber(), start);
    }

    if (isLetter(c) || c === '_') {
      return token('Identifier', readIdentifier(), start);
    }

    if (c === '{') {
      return token('Selector', readBalanced('{', '}'), start);
    }

    if (c === '[') {
      return token('ListLiteral', '[' + readBalanced('[', ']') + ']', start);
    }

    if (c === '#') {
      const end = source.indexOf('#', position + 1);

      if (end < 0) {
        throw new ExpressionError('unterminated #...# at position ' + start);
      }

      const inner = source.substring(position + 1, end);
      position = end + 1;
      return token('Dynamic', inner, start);
    }

    if (c === '(') {
      position++;
      return token('LeftParen', '(', start);
    }

    if (c === ')') {
      position++;
      return token('RightParen', ')', start);
    }

    if (c === ',') {
      position++;
      return token('Comma', ',', start);
    }

    for (const op of OPERATORS) {
      if (source.startsWith(op, position)) {
        position += op.length;
        return token('Operator', op === '=' ? '==' : op, start);
      }
    }

    throw new ExpressionError("unexpected character '" + c + "' at position " + start);
  }

  function skipSpaceAndComments() {
    while (position < source.length) {
      if (isWhiteSpace(source[position])) {
        position++;
      } else if (source.startsWith('/*', position)) {
        const end = source.indexOf('*/', position + 2);
        position = end < 0 ? source.length : end + 2;
      } else {
        return;
      }
    }
  }

  function readString() {
    let value = '';
    position++;

    while (position < source.length) {
      const c = source[position];

      if (c === '\\' && position + 1 < source.length && (source[position + 1] === '"' || source[position + 1] === '\\')) {
        value += source[position + 1];
        position += 2;
      } else if (c === '"') {
        position++;
        return value;
      } else {
        value += c;
        position++;
      }
    }

    throw new ExpressionError('unterminated string literal');
  }

  function readNumber() {
    const start = position;

    while (position < source.length && (isDigit(source[position]) || source[position] === '.')) {
      position++;
    }

    if (position < source.length && (source[position] === 'e' || source[position] === 'E') && position + 1 < source.length
      && (isDigit(source[position + 1]) || source[position + 1] === '-' || source[position + 1] === '+')) {
      position += 2;

      while (position < source.length && isDigit(source[position])) {
        position++;
      }
    }

    return source.substring(start, position);
  }

  function readIdentifier() {
    const start = position;

    while (position < source.length) {
      const c = source[position];

      if (isLetterOrDigit(c) || c === '_') {
        position++;
      } else if (c === '.' && position + 1 < source.length && (isLetterOrDigit(source[position + 1]) || source[position + 1] === '_')) {
        position++;
      } else {
        break;
      }
    }

    return source.substring(start, position);
  }

  // from an opening bracket to its match; quotes inside a selector are respected ([Name = '}'])
  function readBalanced(open, close) {
    const start = position + 1;
    let depth = 0;
    let quote = '';

    while (position < source.length) {
      const c = source[position];

      if (quote) {
        if (c === quote) {
          quote = '';
        }
      } else if ((c === "'" || c === '"') && open === '{') {
        quote = c;
      } else if (c === open) {
        depth++;
      } else if (c === close) {
        depth--;

        if (depth === 0) {
          const inner = source.substring(start, position);
          position++;
          return inner;
        }
      }

      position++;
    }

    throw new ExpressionError('unterminated ' + open + '...' + close);
  }
}

export function isKeyword(name) {
  return KEYWORDS.includes(name.toLowerCase());
}

const INTERPOLATED_REFERENCE = /#([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)#/g;

/** Parses an expression into nodes: { node: 'Empty' | 'String' | 'Number' | 'Boolean' | 'Keyword' | 'Reference' |
 * 'Function' | 'Unary' | 'Binary' | 'Dynamic' | 'ListLiteral', ... }. Throws ExpressionError. */
export function parseExpression(expression) {
  if (expression == null || expression.trim().length === 0) {
    return { node: 'Empty' };
  }

  const tokens = tokenize(expression);
  let index = 0;
  const current = () => tokens[index];

  if (current().kind === 'End') {
    return { node: 'Empty' }; // only a comment
  }

  const result = parseEquality();

  if (current().kind !== 'End') {
    throw new ExpressionError('unexpected ' + current() + ' at position ' + current().position);
  }

  return result;

  // the word operators "and" / "or" are asked only after a complete operand, where a function call cannot follow
  function isOperator(...operators) {
    const t = current();
    return operators.some((op) => (t.kind === 'Operator' && t.text === op) || (t.kind === 'Identifier' && t.text.toLowerCase() === op));
  }

  function takeOperator() {
    const text = current().text.toLowerCase();
    index++;
    return text === 'and' ? '&&' : text === 'or' ? '||' : text;
  }

  function leftAssociative(next, operators) {
    let left = next();

    while (isOperator(...operators)) {
      left = binary(takeOperator(), left, next());
    }

    return left;
  }

  function parseEquality() {
    return leftAssociative(parseOr, ['==', '!=']);
  }

  function parseOr() {
    return leftAssociative(parseAnd, ['||', 'or']);
  }

  function parseAnd() {
    return leftAssociative(parseRelational, ['&&', 'and']);
  }

  function parseRelational() {
    return leftAssociative(parseConcat, ['<', '>', '<=', '>=']);
  }

  function parseConcat() {
    return leftAssociative(parseAdditive, ['&']);
  }

  function parseAdditive() {
    return leftAssociative(parseMultiplicative, ['+', '-']);
  }

  function parseMultiplicative() {
    return leftAssociative(parseExponent, ['*', '/', '%']);
  }

  function parseExponent() {
    const left = parseUnary();

    if (isOperator('^')) {
      takeOperator();
      return binary('^', left, parseExponent());
    }

    return left;
  }

  function parseUnary() {
    if (isOperator('-', '!')) {
      const operator = takeOperator();
      return { node: 'Unary', operator, operand: parseUnary() };
    }

    return parsePrimary();
  }

  function parsePrimary() {
    const t = current();

    switch (t.kind) {
      case 'String':
        index++;
        return stringWithInterpolation(t.text);
      case 'Number':
        index++;
        return { node: 'Number', text: t.text };
      case 'LeftParen': {
        index++;
        const inner = parseEquality();
        expect('RightParen');
        return inner;
      }
      case 'Dynamic':
        index++;
        return { node: 'Dynamic', text: t.text };
      case 'ListLiteral':
        index++;
        return { node: 'ListLiteral', text: t.text };
      case 'Identifier':
        return parseIdentifier();
      default:
        throw new ExpressionError('unexpected ' + t + ' at position ' + t.position);
    }
  }

  function parseIdentifier() {
    const t = current();
    index++;

    if (current().kind === 'LeftParen' && t.text.indexOf('.') < 0) {
      index++;
      const fn = { node: 'Function', name: t.text.toLowerCase(), args: [] };

      if (current().kind !== 'RightParen') {
        fn.args.push(parseEquality());

        while (current().kind === 'Comma') {
          index++;
          fn.args.push(parseEquality());
        }
      }

      expect('RightParen');
      return fn;
    }

    if (t.text.indexOf('.') < 0) {
      const lower = t.text.toLowerCase();

      if (lower === 'true' || lower === 'false') {
        return { node: 'Boolean', value: lower === 'true' };
      }

      if (isKeyword(lower)) {
        return { node: 'Keyword', name: lower };
      }
    }

    const reference = { node: 'Reference', path: t.text, selector: null };

    if (current().kind === 'Selector') {
      reference.selector = current().text;
      index++;
    }

    return reference;
  }

  function expect(kind) {
    if (current().kind !== kind) {
      throw new ExpressionError('expected ' + kind + ' but found ' + current() + ' at position ' + current().position);
    }

    index++;
  }
}

export function referenceScope(reference) {
  const dot = reference.path.indexOf('.');
  return dot >= 0 ? reference.path.substring(0, dot) : reference.path;
}

export function referenceMember(reference) {
  const dot = reference.path.indexOf('.');
  return dot >= 0 ? reference.path.substring(dot + 1) : '';
}

function binary(operator, left, right) {
  return { node: 'Binary', operator, left, right };
}

function text(value) {
  return { node: 'String', value };
}

// "#Local.A# -> #Local.B#": references between hashes inside a string are evaluated; a lone # stays text
function stringWithInterpolation(value) {
  const matches = [...value.matchAll(INTERPOLATED_REFERENCE)];

  if (matches.length === 0) {
    return text(value);
  }

  let result = null;
  let last = 0;
  const append = (node) => (result === null ? node : binary('&', result, node));

  for (const match of matches) {
    if (match.index > last) {
      result = append(text(value.substring(last, match.index)));
    }

    result = append({ node: 'Reference', path: match[1], selector: null });
    last = match.index + match[0].length;
  }

  if (last < value.length) {
    result = append(text(value.substring(last)));
  }

  return result.node === 'Binary' ? result : binary('&', text(''), result);
}
