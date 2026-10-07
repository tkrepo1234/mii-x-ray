// Row records of MII rowset documents (Rowsets/Rowset/Row), the result columns of SQL statements and the structure
// of default documents.
import { MiiXml } from './model.js';
import { XmlNode } from './xml.js';
import { CsType, Naming, UniqueNames } from './types.js';

export class RowsetColumn {
  constructor(name, propertyName, type, tentative) {
    this.name = name; // the element name in the MII document
    this.propertyName = propertyName;
    this.type = type;
    this.tentative = tentative; // a guess from the SQL text; the spelling of a later confirmed use wins
    this.read = false; // read by name in the generated code
  }
}

/** The typed form of an MII rowset document: a row record; the rowset is a List of it. Columns come from reference
 * documents, cached query results, column specifications, the SQL text and the columns the transactions read. */
export class RowsetContract {
  constructor(rowClass, origin) {
    this.rowClass = rowClass;
    this.origin = origin;
    this.columns = [];
    this.passedOnWhole = false; // a whole document is passed on, so unread columns may still be used further on
  }

  get rowTypeName() {
    return this.rowClass;
  }

  get rowsetTypeName() {
    return 'List<' + this.rowClass + '>';
  }

  get signature() {
    return this.columns.map((column) => column.name + ':' + column.type.name).join(',');
  }

  find(name) {
    return this.columns.find((column) => column.name === name) || null;
  }

  /** The column with this name; a tentative column with another spelling is renamed, an unknown one is added. */
  ensure(name) {
    return this.add(name, CsType.String, false);
  }

  add(name, type, tentative) {
    let existing = this.find(name);

    if (!existing) {
      existing = this.columns.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase() && (tentative || candidate.tentative)) || null;
    }

    if (existing) {
      if (!tentative && existing.tentative) {
        existing.name = name;
        existing.propertyName = this._propertyNameFor(name);
        existing.type = type;
        existing.tentative = false;
      }

      return existing;
    }

    const column = new RowsetColumn(name, this._propertyNameFor(name), type, tentative);
    this.columns.push(column);
    return column;
  }

  _propertyNameFor(name) {
    let property = Naming.sanitize(name);

    if (property === this.rowClass || !Naming.isValidIdentifier(property)) {
      property = Naming.pascal(property) + 'Column';
    }

    const names = new UniqueNames();
    names.reserve(this.rowClass);

    for (const other of this.columns) {
      if (other.name !== name) {
        names.reserve(other.propertyName);
      }
    }

    return names.claim(property);
  }
}

/** Contracts from the material MII leaves in the objects. */
export const ContractFactory = {
  /** Adds the columns of an Illuminator rowset document (Columns, else the first Row); false when it is no rowset. */
  addColumnsFromRowsets(contract, document) {
    if (!document || !document.documentElement || document.documentElement.localName !== 'Rowsets') {
      return false;
    }

    const rowset = MiiXml.child(document.documentElement, 'Rowset');

    if (!rowset) {
      return true;
    }

    const columns = MiiXml.children(MiiXml.child(rowset, 'Columns'), 'Column');

    if (columns.length > 0) {
      for (const column of columns) {
        const name = column.getAttribute('Name').trim();

        if (name.length > 0) {
          contract.add(name, ContractFactory.typeOfSqlDataType(column.getAttribute('SQLDataType')), false);
        }
      }

      return true;
    }

    for (const cell of MiiXml.childElements(MiiXml.child(rowset, 'Row'))) {
      contract.add(cell.localName, CsType.String, false);
    }

    return true;
  },

  /** java.sql.Types codes as MII reports them in Column/@SQLDataType. */
  typeOfSqlDataType(code) {
    const text = (code || '').trim();

    if (!/^[+-]?\d+$/.test(text)) {
      return CsType.String;
    }

    switch (parseInt(text, 10)) {
      case -7:
      case 16:
        return CsType.Bool;
      case -6:
      case 5:
      case 4:
        return CsType.Int;
      case -5:
        return CsType.Long;
      case 2:
      case 3:
        return CsType.Decimal;
      case 6:
      case 7:
      case 8:
        return CsType.Double;
      case 91:
      case 93:
        return CsType.DateTime;
      default:
        return CsType.String;
    }
  },

  /** Column types of an IlluminatorDocument column specification (STRING, NUMERIC, DATETIME, ...). */
  typeOfColumnSpecification(text) {
    const value = (text || '').trim().toUpperCase();

    if (value.startsWith('NUM') || value === 'DOUBLE' || value === 'FLOAT' || value === 'DECIMAL') {
      return CsType.Double;
    }

    if (value === 'INTEGER' || value === 'INT' || value === 'LONG') {
      return CsType.Long;
    }

    if (value.startsWith('DATE') || value === 'TIMESTAMP') {
      return CsType.DateTime;
    }

    return value.startsWith('BOOL') ? CsType.Bool : CsType.String;
  },
};

// ---------------------------------------------------------------------------------------------- SQL result columns

const NOT_AN_ALIAS = new Set(['END', 'AS', 'DISTINCT', 'ALL', 'NULL', 'AND', 'OR', 'NOT', 'THEN', 'ELSE', 'WHEN', 'CASE', 'FROM', 'ASC', 'DESC', 'IS']);
const LETTER = /\p{L}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{Nd}]/u;

/** The result column names of an SQL statement: the select list of the last SELECT statement (aliases, dotted
 * names, quoted names). A best effort: "*" and expressions without alias yield nothing. */
export function extractSqlColumns(sql) {
  const result = [];

  if (!sql) {
    return result;
  }

  const statement = lastSelectStatement(tokenizeSql(sql));

  if (!statement) {
    return result;
  }

  for (const item of selectItems(statement)) {
    const name = columnName(item);

    if (name !== null && !result.includes(name)) {
      result.push(name);
    }
  }

  return result;
}

const isWordChar = (c) => LETTER_OR_DIGIT.test(c) || c === '_' || c === '$' || c === ':' || c === '#' || c === '@';

function tokenizeSql(sql) {
  const tokens = [];
  let position = 0;

  while (position < sql.length) {
    const c = sql[position];

    if (/\s/u.test(c)) {
      position++;
    } else if (c === '-' && sql[position + 1] === '-') {
      const end = sql.indexOf('\n', position);
      position = end < 0 ? sql.length : end + 1;
    } else if (c === '/' && sql[position + 1] === '*') {
      const end = sql.indexOf('*/', position + 2);
      position = end < 0 ? sql.length : end + 2;
    } else if (c === "'" || c === '"') {
      let end = position + 1;

      while (end < sql.length) {
        if (sql[end] === c) {
          if (end + 1 < sql.length && sql[end + 1] === c) {
            end += 2;
            continue;
          }

          break;
        }

        end++;
      }

      tokens.push(sql.substring(position, Math.min(end + 1, sql.length)));
      position = end + 1;
    } else if (c === '[') {
      let end = sql.indexOf(']', position);
      end = end < 0 ? sql.length - 1 : end;
      tokens.push(sql.substring(position, end + 1));
      position = end + 1;
    } else if (isWordChar(c)) {
      let end = position;

      while (end < sql.length && isWordChar(sql[end])) {
        end++;
      }

      tokens.push(sql.substring(position, end));
      position = end;
    } else {
      tokens.push(c);
      position++;
    }
  }

  return tokens;
}

const isWord = (token, ...words) => words.some((word) => token.toUpperCase() === word);

function lastSelectStatement(tokens) {
  const statements = [];
  let current = [];
  let depth = 0;

  for (const token of tokens) {
    if (token === '(') {
      depth++;
    } else if (token === ')') {
      depth--;
    }

    if (token === ';' && depth <= 0) {
      statements.push(current);
      current = [];
      continue;
    }

    current.push(token);
  }

  statements.push(current);

  for (let index = statements.length - 1; index >= 0; index--) {
    let start = 0;

    while (start < statements[index].length && isWord(statements[index][start], 'DO', 'BEGIN', 'END')) {
      start++;
    }

    const statement = statements[index].slice(start);

    if (statement.length === 0) {
      continue;
    }

    const select = findTopLevelSelect(statement);

    if (select < 0 || hasTopLevelInto(statement, select)) {
      continue;
    }

    return statement.slice(select);
  }

  return null;
}

function findTopLevelSelect(statement) {
  if (isWord(statement[0], 'SELECT')) {
    return 0;
  }

  if (!isWord(statement[0], 'WITH')) {
    return -1;
  }

  let depth = 0;

  for (let index = 0; index < statement.length; index++) {
    const token = statement[index];

    if (token === '(') {
      depth++;
    } else if (token === ')') {
      depth--;
    } else if (depth === 0 && isWord(token, 'SELECT')) {
      return index;
    }
  }

  return -1;
}

function hasTopLevelInto(statement, select) {
  let depth = 0;

  for (let index = select; index < statement.length; index++) {
    const token = statement[index];

    if (token === '(') {
      depth++;
    } else if (token === ')') {
      depth--;
    } else if (depth === 0 && isWord(token, 'FROM')) {
      return false;
    } else if (depth === 0 && isWord(token, 'INTO')) {
      return true;
    }
  }

  return false;
}

function selectItems(statement) {
  const items = [];
  let index = 1;

  while (index < statement.length && isWord(statement[index], 'DISTINCT', 'ALL')) {
    index++;
  }

  if (index < statement.length && isWord(statement[index], 'TOP')) {
    index += 2;
  }

  let current = [];
  let depth = 0;

  for (; index < statement.length; index++) {
    const token = statement[index];

    if (token === '(') {
      depth++;
    } else if (token === ')') {
      depth--;
    }

    if (depth === 0 && isWord(token, 'FROM')) {
      break;
    }

    if (depth === 0 && token === ',') {
      items.push(current);
      current = [];
      continue;
    }

    current.push(token);
  }

  items.push(current);
  return items;
}

function columnName(item) {
  if (item.length === 0) {
    return null;
  }

  const last = item[item.length - 1];

  if (last === '*') {
    return null;
  }

  if (item.length >= 2 && isWord(item[item.length - 2], 'AS')) {
    return nameOf(last);
  }

  if (item.length === 1) {
    return nameOf(last);
  }

  if (item.length >= 3 && item[item.length - 2] === '.') {
    // t.Column (and nothing before it except further qualifiers)
    for (let index = 0; index < item.length - 2; index++) {
      if (item[index] !== '.' && !isName(item[index])) {
        return null;
      }
    }

    return nameOf(last);
  }

  // expression followed by an implicit alias: "count(*) Total", "x.y Name"
  const previous = item[item.length - 2];

  if (isName(last) && !NOT_AN_ALIAS.has(last.toUpperCase()) && (previous === ')' || isName(previous) || previous.startsWith("'"))) {
    return nameOf(last);
  }

  return null;
}

function nameOf(token) {
  if (token.length >= 2 && token[0] === '"' && token[token.length - 1] === '"') {
    return token.substring(1, token.length - 1).replace(/""/g, '"');
  }

  return !isName(token) || NOT_AN_ALIAS.has(token.toUpperCase()) ? null : token;
}

function isName(token) {
  if (token.length === 0) {
    return false;
  }

  if (token[0] === '"') {
    return true;
  }

  if (!(LETTER.test(token[0]) || token[0] === '_')) {
    return false;
  }

  return [...token].every((c) => LETTER_OR_DIGIT.test(c) || c === '_' || c === '$' || c === '#');
}

// ---------------------------------------------------------------------------------------------- default documents

const XSL_NAMESPACE = 'http://www.w3.org/1999/XSL/Transform';
const KEPT = 2;

/** Default documents are often complete test documents. Of the child elements with the same name only the first two
 * stay, followed by a comment with the number left out. XSLT stylesheets stay as they are. */
export function shrinkXmlSample(text) {
  const document = MiiXml.tryParse(text);

  if (!document || !document.documentElement || document.documentElement.namespaceUri === XSL_NAMESPACE) {
    return text;
  }

  return collapse(document.documentElement) ? document.outerXml : text;
}

function collapse(element) {
  let changed = false;
  const seen = new Map();
  const lastKept = new Map();
  const removed = new Map();

  for (const child of element.elements) {
    const count = seen.get(child.name) || 0;
    seen.set(child.name, count + 1);

    if (count < KEPT) {
      lastKept.set(child.name, child);
      continue;
    }

    const before = child.previousSibling;

    if (before && before.type === 'text' && before.value.trim().length === 0) {
      element.removeChild(before);
    }

    element.removeChild(child);
    removed.set(child.name, (removed.get(child.name) || 0) + 1);
    changed = true;
  }

  for (const [name, count] of removed) {
    const comment = new XmlNode('comment');
    comment.value = ' X-Ray: ' + count + ' more <' + name + '> element' + (count === 1 ? '' : 's') + ' ';
    element.insertAfter(comment, lastKept.get(name));
  }

  for (const child of element.elements) {
    changed = collapse(child) || changed;
  }

  return changed;
}
