// The MII export formats (.trx and the query templates) read into a small model.
import { tryParseXml } from './xml.js';

const XSI_NAMESPACE = 'http://www.w3.org/2001/XMLSchema-instance';

// ---------------------------------------------------------------------------------------------- XML helpers

export const MiiXml = {
  child(parent, name) {
    return parent ? parent.children.find((node) => node.type === 'element' && node.localName === name) || null : null;
  },

  children(parent, name) {
    return parent ? parent.children.filter((node) => node.type === 'element' && node.localName === name) : [];
  },

  childElements(parent) {
    return parent ? parent.children.filter((node) => node.type === 'element') : [];
  },

  /** The text of a child element, or "" when it does not exist. */
  childText(parent, name) {
    const child = MiiXml.child(parent, name);
    return child ? child.innerText : '';
  },

  /** xsi:type without a namespace prefix ("xsd:string" -> "string"). */
  xsiType(element) {
    if (!element) {
      return '';
    }

    const attribute = element.attributes.find((a) => {
      const colon = a.name.indexOf(':');
      return colon >= 0 && a.name.substring(colon + 1) === 'type' && namespaceOfPrefix(element, a.name.substring(0, colon)) === XSI_NAMESPACE;
    });
    const value = attribute ? attribute.value : '';
    const colon = value.indexOf(':');
    return colon >= 0 ? value.substring(colon + 1) : value;
  },

  /** The direct text of an element without its child elements (MII writes <ReferenceDocumentSource/> before the text). */
  ownText(element) {
    if (!element) {
      return '';
    }

    return element.children.filter((node) => node.type === 'text' || node.type === 'cdata').map((node) => node.value).join('');
  },

  tryParse(text) {
    return tryParseXml(text);
  },
};

function namespaceOfPrefix(element, prefix) {
  for (let node = element; node && node.type === 'element'; node = node.parent) {
    const declaration = node.attributes.find((a) => a.name === 'xmlns:' + prefix);

    if (declaration) {
      return declaration.value;
    }
  }

  return prefix === 'xsi' ? XSI_NAMESPACE : '';
}

// ---------------------------------------------------------------------------------------------- model

export class MiiParameter {
  constructor() {
    this.name = '';
    this.type = '';
    this.defaultText = '';
    this.description = '';
    this.referenceSource = '';
    this.isOutput = false;
  }
}

export class MiiActionDefinition {
  constructor(name, actionType, value) {
    this.name = name;
    this.actionType = actionType;
    this.value = value;
  }

  property(name) {
    return MiiXml.child(this.value, name);
  }

  hasProperty(name) {
    return this.property(name) !== null;
  }

  /** The configured value of a property: its own text, trimmed ("" when missing). */
  static(name) {
    return MiiXml.ownText(this.property(name)).trim();
  }
}

export class MiiTransaction {
  constructor(path) {
    this.path = path;
    this.description = '';
    this.throwOnLinkError = ''; // the transaction attribute; false or 0: a failing link does not stop the run
    this.inputs = [];
    this.outputs = [];
    this.locals = [];
    this.actions = new Map();
    this.steps = [];
  }

  get shortName() {
    const slash = this.path.lastIndexOf('/');
    return slash >= 0 ? this.path.substring(slash + 1) : this.path;
  }

  /** Every action use of the step tree in execution (pre-)order. */
  allActionUses() {
    const result = [];
    const collect = (step) => {
      if (step.action) {
        result.push(step.action);
      }

      step.children.forEach(collect);
    };
    this.steps.forEach(collect);
    return result;
  }
}

export const MiiQueryKind = { Sql: 'Sql', Mdo: 'Mdo', Xml: 'Xml', Xacute: 'Xacute', Other: 'Other' };

export class MiiQuery {
  constructor(path) {
    this.path = path;
    this.kind = MiiQueryKind.Other;
    this.rootName = '';
    this.mode = '';
    this.text = '';
    this.rowCount = ''; // RowCount of the template: MII returns at most this many rows
    this.typedParameters = false; // UseTypedParams
    this.url = '';
    this.parameters = []; // { slot, description, type, defaultValue }
    this.xacuteTransaction = '';
    this.xacuteOutputParameter = '';
    this.xacuteMappedTargets = new Map();
  }

  get shortName() {
    const slash = this.path.lastIndexOf('/');
    return slash >= 0 ? this.path.substring(slash + 1) : this.path;
  }

  findParameter(slot) {
    return this.parameters.find((parameter) => parameter.slot === slot) || null;
  }
}

// ---------------------------------------------------------------------------------------------- reader

export const ObjectReader = {
  isTransaction(document) {
    return document.documentElement !== null && document.documentElement.localName === 'Transaction';
  },

  readTransaction(path, document) {
    const root = document.documentElement;
    const transaction = new MiiTransaction(path);
    transaction.description = readAttribute(MiiXml.child(root, 'TransactionAttributes'), 'Description');
    transaction.throwOnLinkError = readAttribute(MiiXml.child(root, 'TransactionAttributes'), 'ThrowOnLinkError').trim();

    for (const item of MiiXml.children(MiiXml.child(root, 'Context'), 'ContextItem')) {
      const parameter = readParameter(item);
      parameter.isOutput = MiiXml.childText(item, 'ReadOnly').trim().toLowerCase() === 'true';
      (parameter.isOutput ? transaction.outputs : transaction.inputs).push(parameter);
    }

    for (const item of MiiXml.children(MiiXml.child(root, 'Local'), 'ContextItem')) {
      transaction.locals.push(readParameter(item));
    }

    for (const item of MiiXml.children(MiiXml.child(root, 'Actions'), 'ContextItem')) {
      const name = MiiXml.childText(item, 'Name');
      const value = MiiXml.child(item, 'Value');

      if (name.length > 0 && !transaction.actions.has(name)) {
        transaction.actions.set(name, new MiiActionDefinition(name, MiiXml.xsiType(value), value));
      }
    }

    for (const step of MiiXml.children(MiiXml.child(root, 'Steps'), 'Step')) {
      transaction.steps.push(readStep(step, transaction));
    }

    return transaction;
  },

  readQuery(path, document) {
    const root = document.documentElement;
    const query = new MiiQuery(path);
    query.rootName = root.localName;
    query.mode = root.getAttribute('Mode');
    query.rowCount = root.getAttribute('RowCount').trim();
    // Use Typed Parameters: the values are bound as statement parameters instead of replacing [Param.N] as text
    query.typedParameters = /^(t|true)$/i.test(root.getAttribute('UseTypedParams').trim());

    switch (root.localName) {
      case 'SQLQuery':
        query.kind = MiiQueryKind.Sql;
        query.text = root.getAttribute('Query');
        break;
      case 'MDOQuery':
        query.kind = MiiQueryKind.Mdo;
        query.text = buildMdoStatement(root);
        break;
      case 'XMLQuery':
        query.kind = MiiQueryKind.Xml;
        query.url = root.getAttribute('URL');
        query.text = query.url;
        break;
      case 'XacuteQuery':
        query.kind = MiiQueryKind.Xacute;
        query.xacuteTransaction = root.getAttribute('Transaction').trim();
        query.xacuteOutputParameter = root.getAttribute('OutputParameter').trim();

        for (let slot = 1; slot <= 32; slot++) {
          const target = root.getAttribute('MappedParamTarget.' + slot).trim();

          if (target.length > 0) {
            query.xacuteMappedTargets.set(slot, target);
          }
        }

        query.text = '';
        break;
      default:
        query.kind = MiiQueryKind.Other;
        query.text = root.getAttribute('Query');
        break;
    }

    readQueryParameters(root, query);
    return query;
  },
};

function readAttribute(attributes, name) {
  for (const item of MiiXml.children(attributes, 'ContextItem')) {
    if (MiiXml.childText(item, 'Name') === name) {
      return MiiXml.ownText(MiiXml.child(item, 'Value')).trim();
    }
  }

  return '';
}

function readParameter(item) {
  const parameter = new MiiParameter();
  const value = MiiXml.child(item, 'Value');
  parameter.name = MiiXml.childText(item, 'Name');
  parameter.description = MiiXml.childText(item, 'Description').trim();
  parameter.type = MiiXml.xsiType(value);
  parameter.defaultText = MiiXml.ownText(value);
  parameter.referenceSource = MiiXml.childText(value, 'ReferenceDocumentSource').trim();

  if (parameter.type !== 'xml') {
    parameter.defaultText = parameter.defaultText.trim();
  }

  return parameter;
}

function readStep(element, transaction) {
  const step = { stepType: MiiXml.xsiType(element), name: MiiXml.childText(element, 'Name'), action: null, children: [] };
  const action = MiiXml.child(MiiXml.child(element, 'Actions'), 'Action');

  if (action) {
    const name = MiiXml.childText(action, 'Name');
    step.action = {
      name,
      incoming: readLinks(MiiXml.child(action, 'IncomingLinks')),
      outgoing: readLinks(MiiXml.child(action, 'OutgoingLinks')),
      definition: transaction.actions.get(name) || null,
    };
  }

  for (const child of MiiXml.children(MiiXml.child(element, 'Steps'), 'Step')) {
    step.children.push(readStep(child, transaction));
  }

  return step;
}

function readLinks(links) {
  return MiiXml.children(links, 'Assign').map((assign) => ({
    kind: MiiXml.xsiType(assign) || 'Assign',
    from: MiiXml.childText(assign, 'From'),
    to: MiiXml.childText(assign, 'To').trim(),
  }));
}

function readQueryParameters(root, query) {
  const inText = new Set();

  for (const match of query.text.matchAll(/\[Param\.(\d+)\]/g)) {
    inText.add(parseInt(match[1], 10));
  }

  for (let slot = 1; slot <= 32; slot++) {
    const description = root.getAttribute('ParamDescription.' + slot).trim();

    if (description.length === 0 && !inText.has(slot) && !query.xacuteMappedTargets.has(slot)) {
      continue;
    }

    query.parameters.push({
      slot,
      description,
      type: root.getAttribute('ParamType.' + slot).trim(),
      defaultValue: root.getAttribute('Param.' + slot),
    });
  }
}

/** An MDO query has no statement text; X-Ray writes a readable one from its settings. */
function buildMdoStatement(root) {
  const mdo = root.getAttribute('MDO');
  const mode = root.getAttribute('Mode');
  const filter = root.getAttribute('FilterExpr').trim();
  const sort = root.getAttribute('SortExpr').trim();
  let text = '/* MDO query, mode ' + mode + ' */ ';

  if (mode.toLowerCase() === 'select') {
    const attributes = root.getAttribute('Attributes').trim();
    text += 'SELECT ' + (attributes.length > 0 ? attributes : '*') + ' FROM [' + mdo + ']';
  } else if (mode.toLowerCase() === 'delete') {
    text += 'DELETE FROM [' + mdo + ']';
  } else {
    const assignments = [];

    for (let index = 1; index <= 128; index++) {
      const name = root.getAttribute('AttributeName.' + index).trim();

      if (name.length > 0) {
        assignments.push('[' + name + '] = ' + root.getAttribute('AttributeValue.' + index).trim());
      }
    }

    text += mode.toLowerCase() === 'insert'
      ? 'INSERT INTO [' + mdo + '] SET ' + assignments.join(', ')
      : mode.toUpperCase() + ' [' + mdo + '] SET ' + assignments.join(', ');
  }

  if (filter.length > 0) {
    text += ' WHERE ' + filter;
  }

  if (sort.length > 0) {
    text += ' ORDER BY ' + sort;
  }

  return text;
}
