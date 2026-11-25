// Minifies the page for the MII server without dependencies.
// JavaScript: comments, indentation and needless line breaks go (a line break stays where automatic semicolon
// insertion could happen); strings, template literals and regular expressions stay as they are. With rename, every
// name the code declares (variables, constants, functions, classes, parameters) gets a short name, the same one
// everywhere. That is safe without scope analysis because the renaming is one to one and the short names are names the
// code nowhere uses. Left as they are: property names (a.x, object keys, methods, getters), names written as
// shorthand ({ a }, which is a key as well), globals and keywords.
// CSS and HTML lose comments and needless blanks.

const WORD_START = /[A-Za-z_$\u0080-￿]/;
const WORD = /[A-Za-z0-9_$\u0080-￿]/;
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);

// a line break can go after a token that always needs more, or before one that continues the statement (+ and - are
// not in the lists: they may be ++ or --; return, break, continue, throw and yield are words, also not in the lists)
const JOIN_AFTER = new Set(['{', '(', '[', ',', ';', ':', '?', '=', '&', '|', '*', '%', '<', '>', '!', '~', '^', '.']);
const JOIN_BEFORE = new Set([')', ']', '}', ',', ';', ':', '?', '=', '&', '|', '*', '%', '<', '>', '.']);

const KEYWORDS = new Set(('break case catch class const continue debugger default delete do else export extends finally for function if '
  + 'import in instanceof new return super switch this throw try typeof var void while with yield let static enum await '
  + 'implements package protected interface private public null true false async of get set arguments '
  + 'undefined NaN Infinity eval as from').split(' '));

// names of the browser that the page may use without declaring them (besides those of the JavaScript engine)
const BROWSER_GLOBALS = ('window self document navigator location history localStorage sessionStorage fetch atob btoa '
  + 'alert confirm prompt console setTimeout clearTimeout setInterval clearInterval requestAnimationFrame '
  + 'TextEncoder TextDecoder DOMParser XMLSerializer Blob File FileReader URL URLSearchParams FormData Headers Request '
  + 'Response AbortController Event CustomEvent KeyboardEvent MouseEvent Node Element HTMLElement Document '
  + 'getComputedStyle matchMedia crypto performance structuredClone queueMicrotask CompressionStream '
  + 'DecompressionStream').split(' ');

// ---------------------------------------------------------------------------------------------- tokens

/** Tokens: { type: word|number|string|template|regex|punct, text, newline (a line break before), space }. */
function tokenize(source) {
  const tokens = [];
  const stack = []; // '{' or '${' (a substitution of a template literal)
  let position = 0;
  let newline = false;
  let space = false;

  const push = (type, text) => {
    tokens.push({ type, text, newline, space });
    newline = false;
    space = false;
  };

  const regexAllowed = () => {
    const last = tokens[tokens.length - 1];

    if (!last) {
      return true;
    }

    if (last.type === 'word') {
      return REGEX_AFTER_WORD.has(last.text);
    }

    if (last.type === 'template') {
      return last.text.endsWith('${');
    }

    return last.type === 'punct' && last.text !== ')' && last.text !== ']';
  };

  const endOfQuoted = (start, quote) => {
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

  // from just after ` or the } of a substitution to the end of the template part
  const endOfTemplate = (start) => {
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

  const endOfRegex = (start) => {
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
      newline = true;
      position++;
    } else if (c === ' ' || c === '\t' || c === '﻿') {
      space = true;
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

      newline = newline || source.substring(position, end).includes('\n');
      space = true;
      position = end + 2;
    } else if (c === '"' || c === "'") {
      const end = endOfQuoted(position, c);
      push('string', source.substring(position, end));
      position = end;
    } else if (c === '`' || (c === '}' && stack[stack.length - 1] === '${')) {
      if (c === '}') {
        stack.pop();
      }

      const [end, substitution] = endOfTemplate(position + 1);
      push('template', source.substring(position, end));

      if (substitution) {
        stack.push('${');
      }

      position = end;
    } else if (c === '/' && regexAllowed()) {
      const end = endOfRegex(position);
      push('regex', source.substring(position, end));
      position = end;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(source[position + 1] || ''))) {
      let end = position + 1;

      while (end < source.length && /[0-9A-Za-z_.]/.test(source[end]) && !(source[end] === '.' && source[end + 1] === '.')) {
        end++;
      }

      push('number', source.substring(position, end));
      position = end;
    } else if (WORD_START.test(c)) {
      let end = position + 1;

      while (end < source.length && WORD.test(source[end])) {
        end++;
      }

      push('word', source.substring(position, end));
      position = end;
    } else {
      if (c === '{') {
        stack.push('{');
      } else if (c === '}') {
        stack.pop();
      }

      push('punct', c);
      position++;
    }
  }

  if (stack.length > 0) {
    throw new Error('unbalanced braces');
  }

  return tokens;
}

function print(tokens) {
  let out = '';
  let last = null;

  for (const token of tokens) {
    if (last !== null) {
      const before = out[out.length - 1];
      const after = token.text[0];
      const joinable = (last.type === 'punct' && JOIN_AFTER.has(last.text)) || (last.type === 'template' && last.text.endsWith('${'))
        || (token.type === 'punct' && JOIN_BEFORE.has(token.text));

      if (token.newline && !joinable) {
        out += '\n';
      } else if ((token.space || token.newline) && ((WORD.test(before) && WORD.test(after))
        || (before === after && (before === '+' || before === '-' || before === '/'))
        || (/[0-9]/.test(before) && after === '.'))) {
        out += ' ';
      }
    }

    out += token.text;
    last = token;
  }

  return out + '\n';
}

// ---------------------------------------------------------------------------------------------- renaming

const isPunct = (token, text) => token !== undefined && token.type === 'punct' && token.text === text;
const isWord = (token, text) => token !== undefined && token.type === 'word' && (text === undefined || token.text === text);

/** For every bracket its partner, and for every token the kind of the innermost brace around it: 'object' (object
 * literal or destructuring pattern), 'class' (class body) or 'block'. */
function structure(tokens) {
  const partner = new Array(tokens.length).fill(-1);
  const braceKind = new Array(tokens.length).fill('block');
  const open = [];
  let classPending = false;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    braceKind[index] = open.length > 0 ? open[open.length - 1].kind : 'block';

    if (isWord(token, 'class')) {
      classPending = true;
    }

    if (token.type !== 'punct') {
      continue;
    }

    if (token.text === '{' || token.text === '(' || token.text === '[') {
      let kind = open.length > 0 ? open[open.length - 1].kind : 'block';

      if (token.text === '{') {
        const before = tokens[index - 1];

        if (classPending) {
          kind = 'class';
          classPending = false;
        } else if (before === undefined) {
          kind = 'block';
        } else if (before.type === 'punct') {
          kind = ['=', '(', ',', ':', '[', '?', '|', '&', '!', '.'].includes(before.text) ? 'object' : 'block';
        } else if (before.type === 'template') {
          kind = 'object';
        } else {
          kind = ['return', 'const', 'let', 'var', 'typeof', 'in', 'of', 'throw', 'case', 'yield', 'await'].includes(before.text) ? 'object' : 'block';
        }
      }

      open.push({ index, kind });
    } else if (token.text === '}' || token.text === ')' || token.text === ']') {
      const opened = open.pop();
      partner[opened.index] = index;
      partner[index] = opened.index;
    }
  }

  return { partner, braceKind };
}

/** The positions of the names a binding pattern declares (a name, { a, b: c = 1 }, [a, ...b]) from start to end. */
function patternNames(tokens, start, end, result) {
  let depth = 0;
  let defaultDepth = -1; // inside a default value (after =) at this depth

  for (let index = start; index < end; index++) {
    const token = tokens[index];

    if (token.type === 'punct') {
      if ('{[('.includes(token.text)) {
        depth++;
      } else if ('}])'.includes(token.text)) {
        depth--;

        if (defaultDepth > depth) {
          defaultDepth = -1;
        }
      } else if (token.text === ',' && depth === defaultDepth) {
        defaultDepth = -1;
      } else if (token.text === '=' && defaultDepth < 0 && !isPunct(tokens[index + 1], '=') && !isPunct(tokens[index + 1], '>') && !isPunct(tokens[index - 1], '=')) {
        defaultDepth = depth;
      }

      continue;
    }

    if (defaultDepth >= 0 || token.type !== 'word' || KEYWORDS.has(token.text) || isPunct(tokens[index - 1], '.') && !isPunct(tokens[index - 2], '.')) {
      continue;
    }

    const next = tokens[index + 1];

    if (!isPunct(next, ':')) {
      result.add(index);
    }
  }
}

/** Renames the declared names (except those in keep); returns the tokens with new texts. */
function rename(tokens, keep) {
  const { partner, braceKind } = structure(tokens);
  const declared = new Set(); // positions of declaring names
  const keyPositions = new Set(); // positions of property names (not renamed)
  const fixed = new Set(); // names that are never renamed
  const used = new Set(tokens.filter((token) => token.type === 'word').map((token) => token.text));

  for (const name of Object.getOwnPropertyNames(globalThis).concat(BROWSER_GLOBALS, [...keep])) {
    fixed.add(name);
  }

  const groupEnd = (index) => partner[index] >= 0 ? partner[index] : index;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const before = tokens[index - 1];
    const next = tokens[index + 1];

    if (token.type !== 'word') {
      continue;
    }

    const kind = braceKind[index];

    // property names
    if (isPunct(before, '.') && !isPunct(tokens[index - 2], '.')) {
      keyPositions.add(index);
      continue;
    }

    const memberStart = before === undefined || (before.type === 'punct' && ['{', ',', '}', ';'].includes(before.text))
      || ['static', 'get', 'set', 'async'].includes(before.text) || isPunct(before, '*');

    if ((kind === 'object' || kind === 'class') && memberStart && isPunct(next, ':') && !isPunct(before, '?')) {
      keyPositions.add(index);
      continue;
    }

    if ((kind === 'object' || kind === 'class') && memberStart && isPunct(next, '(') && isPunct(tokens[groupEnd(index + 1) + 1], '{')) {
      keyPositions.add(index); // a method or getter

      if (['get', 'set', 'async', 'static'].includes(token.text) && isWord(next)) {
        continue;
      }
    }

    // shorthand properties and patterns ({ a }, { a = 1 }) are keys as well: the name stays
    if (kind === 'object' && (isPunct(before, '{') || isPunct(before, ',')) && (isPunct(next, ',') || isPunct(next, '}')
      || (isPunct(next, '=') && !isPunct(tokens[index + 2], '=') && !isPunct(tokens[index + 2], '>')))) {
      fixed.add(token.text);
    }

    // declarations
    if (['const', 'let', 'var'].includes(token.text) && next !== undefined) {
      // each declarator up to = (a pattern ends with its bracket)
      let position = index + 1;

      while (position < tokens.length) {
        if (isPunct(tokens[position], '{') || isPunct(tokens[position], '[')) {
          patternNames(tokens, position, groupEnd(position) + 1, declared);
          position = groupEnd(position) + 1;
        } else if (isWord(tokens[position])) {
          declared.add(position);
          position++;
        } else {
          break;
        }

        // skip the initializer up to the next declarator (a comma at this depth) or the end
        if (isPunct(tokens[position], ',')) {
          position++;
          continue;
        }

        if (!isPunct(tokens[position], '=')) {
          break;
        }

        while (position < tokens.length && !isPunct(tokens[position], ',') && !isPunct(tokens[position], ';') && !isPunct(tokens[position], ')')
          && !isPunct(tokens[position], '}')) {
          position = '{(['.includes(tokens[position].text) && tokens[position].type === 'punct' ? groupEnd(position) + 1 : position + 1;
        }

        if (!isPunct(tokens[position], ',')) {
          break;
        }

        position++;
      }
    } else if ((token.text === 'function' || token.text === 'class') && isWord(next) && !KEYWORDS.has(next.text)) {
      declared.add(index + 1);
    } else if (isPunct(next, '=') && isPunct(tokens[index + 2], '>')) {
      declared.add(index); // x => ...
    }
  }

  // parameter lists: ( ... ) => and ( ... ) { of a function, method or catch
  for (let index = 0; index < tokens.length; index++) {
    if (!isPunct(tokens[index], '(') || partner[index] < 0) {
      continue;
    }

    const close = partner[index];
    const after = tokens[close + 1];
    const before = tokens[index - 1];
    const arrow = isPunct(after, '=') && isPunct(tokens[close + 2], '>');
    const body = isPunct(after, '{') && before !== undefined && (before.type === 'word' || isPunct(before, '*'))
      && !['if', 'for', 'while', 'switch', 'with'].includes(before.text);

    if (arrow || body) {
      patternNames(tokens, index + 1, close, declared);
    }
  }

  const names = new Map();

  for (const index of declared) {
    const name = tokens[index].text;

    if (!fixed.has(name) && !KEYWORDS.has(name) && !keyPositions.has(index)) {
      names.set(name, 0);
    }
  }

  tokens.forEach((token, index) => {
    if (token.type === 'word' && names.has(token.text) && !keyPositions.has(index)) {
      names.set(token.text, names.get(token.text) + 1);
    }
  });

  const short = shortNames(used, fixed);
  const mapping = new Map([...names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => [name, short.next().value]));

  return tokens.map((token, index) => token.type === 'word' && mapping.has(token.text) && !keyPositions.has(index)
    ? { ...token, text: mapping.get(token.text) } : token);
}

/** a, b, ..., Z, aa, ab, ... without the names the code uses, keywords and globals. */
function* shortNames(used, fixed) {
  const first = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$';
  const rest = first + '0123456789';

  for (let length = 1; ; length++) {
    const counters = new Array(length).fill(0);

    while (true) {
      const name = counters.map((value, position) => (position === 0 ? first : rest)[value]).join('');

      if (!used.has(name) && !fixed.has(name) && !KEYWORDS.has(name)) {
        yield name;
      }

      let position = length - 1;

      while (position >= 0) {
        counters[position]++;

        if (counters[position] < (position === 0 ? first : rest).length) {
          break;
        }

        counters[position] = 0;
        position--;
      }

      if (position < 0) {
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------- entry points

/** JavaScript without comments and needless white space; with options.rename the declared names are shortened
 * (options.keep: names that stay, such as those a module exports). */
export function minifyJs(source, options = {}) {
  const tokens = tokenize(source);
  return print(options.rename ? rename(tokens, new Set(options.keep || [])) : tokens);
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
