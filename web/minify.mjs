// Minifies the page for the MII server without dependencies: JavaScript loses comments, indentation and blank lines
// (a line break stays where one was, so automatic semicolon insertion is unchanged); strings, template literals and
// regular expressions stay as they are. CSS loses comments and needless blanks.

const WORD = /[A-Za-z0-9_$\u0080-￿]/;
// after these words a slash starts a regular expression, after any other word it divides
// A line break can go where automatic semicolon insertion cannot happen: after a token that always needs more (an
// opening bracket, a separator, an operator other than + and -, which may be a postfix ++ or --) or before a token
// that continues the statement (a closing bracket, a separator, an operator other than + and -, which may be a
// prefix ++ or --). A break after return, break, continue, throw or yield stays (none of them is in the lists).
const JOIN_AFTER = new Set(['{', '(', '[', ',', ';', ':', '?', '=', '&', '|', '*', '%', '<', '>', '!', '~', '^', '.']);
const JOIN_BEFORE = new Set([')', ']', '}', ',', ';', ':', '?', '=', '&', '|', '*', '%', '<', '>', '.']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);

/** JavaScript without comments and needless white space. */
export function minifyJs(source) {
  let out = '';
  let position = 0;
  let pendingSpace = false;
  let pendingBreak = false;
  let last = ''; // the last significant token: 'word:<text>', 'number', 'string', 'regex' or the punctuator
  const stack = []; // '{' for a block or object, '${' for a substitution in a template literal

  const emit = (text, token) => {
    if (out.length > 0) {
      const before = out[out.length - 1];
      const after = text[0];

      if (pendingBreak && !JOIN_AFTER.has(last) && !JOIN_BEFORE.has(after)) {
        out += '\n';
      } else if ((pendingSpace || pendingBreak) && (WORD.test(before) && WORD.test(after)
        || (before === after && (before === '+' || before === '-' || before === '/'))
        || (/[0-9]/.test(before) && after === '.'))) {
        out += ' ';
      }
    }

    pendingSpace = false;
    pendingBreak = false;
    out += text;
    last = token;
  };

  const regexAllowed = () => {
    if (last === '' ) {
      return true;
    }

    if (last.startsWith('word:')) {
      return REGEX_AFTER_WORD.has(last.substring(5));
    }

    return !(last === 'number' || last === 'string' || last === 'regex' || last === ')' || last === ']');
  };

  // a string, template part or regular expression body up to its end, escapes kept
  const readQuoted = (start, quote) => {
    let index = start + 1;

    while (index < source.length && source[index] !== quote) {
      if (source[index] === '\\') {
        index++;
      } else if (source[index] === '\n') {
        throw new Error('line break in a string at ' + start);
      }

      index++;
    }

    return index + 1;
  };

  // from just after ` or } of a substitution to the end of the template part: returns [end, endsWithSubstitution]
  const readTemplate = (start) => {
    let index = start;

    while (index < source.length) {
      const c = source[index];

      if (c === '\\') {
        index += 2;
      } else if (c === '`') {
        return [index + 1, false];
      } else if (c === '$' && source[index + 1] === '{') {
        return [index + 2, true];
      } else {
        index++;
      }
    }

    throw new Error('unterminated template literal at ' + start);
  };

  const readRegex = (start) => {
    let index = start + 1;
    let inClass = false;

    while (index < source.length) {
      const c = source[index];

      if (c === '\\') {
        index += 2;
        continue;
      }

      if (c === '\n') {
        throw new Error('line break in a regular expression at ' + start);
      }

      if (inClass) {
        inClass = c !== ']';
      } else if (c === '[') {
        inClass = true;
      } else if (c === '/') {
        index++;

        while (index < source.length && /[a-z]/.test(source[index])) {
          index++;
        }

        return index;
      }

      index++;
    }

    throw new Error('unterminated regular expression at ' + start);
  };

  while (position < source.length) {
    const c = source[position];

    if (c === '\n' || c === '\r') {
      pendingBreak = true;
      position++;
    } else if (c === ' ' || c === '\t' || c === '﻿') {
      pendingSpace = true;
      position++;
    } else if (c === '/' && source[position + 1] === '/') {
      while (position < source.length && source[position] !== '\n') {
        position++;
      }
    } else if (c === '/' && source[position + 1] === '*') {
      const end = source.indexOf('*/', position + 2);

      if (end < 0) {
        throw new Error('unterminated comment at ' + position);
      }

      if (source.substring(position, end).includes('\n')) {
        pendingBreak = true;
      } else {
        pendingSpace = true;
      }

      position = end + 2;
    } else if (c === '"' || c === "'") {
      const end = readQuoted(position, c);
      emit(source.substring(position, end), 'string');
      position = end;
    } else if (c === '`' || (c === '}' && stack[stack.length - 1] === '${')) {
      if (c === '}') {
        stack.pop();
      }

      const [end, substitution] = readTemplate(position + 1);
      emit(source.substring(position, end), substitution ? '${' : 'string');

      if (substitution) {
        stack.push('${');
        last = '(';
      }

      position = end;
    } else if (c === '/' && regexAllowed()) {
      const end = readRegex(position);
      emit(source.substring(position, end), 'regex');
      position = end;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(source[position + 1] || ''))) {
      let end = position + 1;

      while (end < source.length && /[0-9A-Za-z_.]/.test(source[end])) {
        if (source[end] === '.' && source[end + 1] === '.') {
          break;
        }

        end++;
      }

      emit(source.substring(position, end), 'number');
      position = end;
    } else if (WORD.test(c)) {
      let end = position + 1;

      while (end < source.length && WORD.test(source[end])) {
        end++;
      }

      const word = source.substring(position, end);
      emit(word, 'word:' + word);
      position = end;
    } else {
      if (c === '{') {
        stack.push('{');
      } else if (c === '}') {
        stack.pop();
      }

      emit(c, c);
      position++;
    }
  }

  if (stack.length > 0) {
    throw new Error('unbalanced braces');
  }

  return out + '\n';
}

/** CSS without comments and needless blanks. */
export function minifyCss(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};,>])\s*/g, '$1')
    .replace(/:\s+/g, ':')
    .replace(/;}/g, '}')
    .trim();
}

/** HTML: comments (except the build placeholders) and blanks between tags. */
export function minifyHtml(source) {
  return source
    .replace(/<!--(?!STYLE-->|SCRIPT-->)[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .trim() + '\n';
}
