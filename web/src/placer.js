// Declarations where the value comes into being, and the blank-line layout of the generated code.

const CATCH_CLAUSE = /^catch \(Exception (\w+)\)$/;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A variable assigned exactly once and read only afterwards in the same block (or below) is declared at its
 * assignment (var); a Catch result becomes the catch clause's variable. Changes the flow in place and returns the
 * variables that must stay at the top. The braces of the flow always stand on lines of their own. */
export function placeDeclarations(flow, variables) {
  return variables.filter((variable) => !tryPlace(flow, variable));
}

function tryPlace(flow, variable) {
  const word = new RegExp('(?<![\\w.@])' + escape(variable.name) + '\\b', 'g');
  const assignment = new RegExp('^\\s*' + escape(variable.name) + ' = ');
  let assigned = -1;
  const uses = [];

  for (let index = 0; index < flow.length; index++) {
    if (assignment.test(flow[index])) {
      if (assigned >= 0) {
        return false;
      }

      assigned = index;

      if ((flow[index].match(word) || []).length > 1) {
        return false; // the new value is built from the old one
      }
    } else if (flow[index].match(word)) {
      uses.push(index);
    }
  }

  if (assigned < 0) {
    return false;
  }

  const { blocks, parents } = blockStructure(flow);

  for (const use of uses) {
    if (use < assigned || !isInside(blocks[use], blocks[assigned], parents)) {
      return false;
    }
  }

  if (variable.isCatch) {
    return renameCatchVariable(flow, variable, assigned);
  }

  const line = flow[assigned];
  const indentation = line.length - line.trimStart().length;
  flow.splice(assigned, 1, ...withMiiName(line.substring(0, indentation) + 'var ' + line.substring(indentation), variable.placedMiiName || variable.miiName));
  return true;
}

/** A declaration with its MII comment (one text or several lines): one line at the end of a one-line statement,
 * else above it (nothing may follow the opening quotes of a raw string). */
export function withMiiName(line, comment) {
  const comments = comment ? [].concat(comment) : [];

  if (comments.length === 0) {
    return [line];
  }

  if (comments.length === 1 && !line.includes('\n') && line.trimEnd().endsWith(';')) {
    return [line + ' // ' + comments[0]];
  }

  const indentation = line.substring(0, line.length - line.trimStart().length);
  return comments.map((text) => indentation + '// ' + text).concat([line]);
}

/** "catch (Exception xError) ... x = xError;" becomes "catch (Exception x)". */
function renameCatchVariable(flow, variable, assigned) {
  let error = flow[assigned].trim().substring(variable.name.length + 3);
  error = error.replace(/;+$/, '');

  for (let index = assigned - 1; index >= 0; index--) {
    const clause = CATCH_CLAUSE.exec(flow[index].trim());

    if (clause && clause[1] === error) {
      flow.splice(assigned, 1);
      const errorWord = new RegExp('(?<![\\w.@])' + escape(error) + '\\b', 'g');

      for (let line = index; line < flow.length; line++) {
        flow[line] = flow[line].replace(errorWord, variable.name);
      }

      return true;
    }
  }

  return false;
}

/** The block of every line (0 = the method body) and the parent of every block. */
function blockStructure(flow) {
  const blocks = new Array(flow.length);
  const parents = [-1];
  const open = [0];

  for (let index = 0; index < flow.length; index++) {
    const text = flow[index].trim();

    if (text === '{') {
      blocks[index] = open[open.length - 1];
      parents.push(open[open.length - 1]);
      open.push(parents.length - 1);
    } else if (text === '}' && open.length > 1) {
      blocks[index] = open.pop();
    } else {
      blocks[index] = open[open.length - 1];
    }
  }

  return { blocks, parents };
}

function isInside(block, ancestor, parents) {
  for (let current = block; current >= 0; current = parents[current]) {
    if (current === ancestor) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------------------------- layout

const CONTROL_STATEMENT = /^((if|for|foreach|while|do|try|switch|lock)(\s|\(|$)|using\s*\()/;
const CONTINUATION = /^(else|catch|finally|while)(\s|\(|$)/;

/** After a closing brace a blank line, unless the enclosing block ends there or else/catch/finally follows; before a
 * loop, condition, try, switch, using or lock a blank line, unless it starts its block or one is already there.
 * Comment lines directly above a statement stay with it. */
export function addBlankLines(lines) {
  const result = [];

  for (const line of lines) {
    const text = line.trim();

    if (text.length > 0 && result.length > 0) {
      const previous = result[result.length - 1].trim();

      if ((previous === '}' || previous === '};' || previous === '});') && !text.startsWith('}') && !CONTINUATION.test(text)) {
        result.push('');
      } else if (CONTROL_STATEMENT.test(text)) {
        insertBlankBeforeComments(result);
      }
    }

    result.push(line);
  }

  return result;
}

function insertBlankBeforeComments(result) {
  let index = result.length;

  while (index > 0 && isComment(result[index - 1].trim())) {
    index--;
  }

  if (index === 0) {
    return;
  }

  const above = result[index - 1].trim();

  if (above.length === 0 || above.endsWith('{') || above.endsWith(':')) {
    return;
  }

  result.splice(index, 0, '');
}

const isComment = (text) => text.startsWith('//') && !text.startsWith('///');
