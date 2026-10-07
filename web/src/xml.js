// A small XML parser and serializer without dependencies, the same in the browser and in Node.
// It behaves like System.Xml (the C# version of X-Ray): line ends are normalized (\r\n and \r become \n), literal
// tabs and line breaks in attribute values become spaces (character references stay), whitespace is preserved, and
// the serializer writes what XmlDocument.OuterXml writes.

export class XmlNode {
  constructor(type, name) {
    this.type = type; // 'document' | 'element' | 'text' | 'cdata' | 'comment' | 'declaration' | 'pi'
    this.name = name || '';
    this.attributes = []; // [{ name, value }]
    this.children = [];
    this.value = '';
    this.parent = null;
  }

  get localName() {
    const colon = this.name.indexOf(':');
    return colon >= 0 ? this.name.substring(colon + 1) : this.name;
  }

  get documentElement() {
    return this.children.find((child) => child.type === 'element') || null;
  }

  getAttribute(name) {
    const attribute = this.attributes.find((a) => a.name === name);
    return attribute ? attribute.value : '';
  }

  hasAttribute(name) {
    return this.attributes.some((a) => a.name === name);
  }

  /** The namespace URI of the element's prefix (or default namespace), looked up through the ancestors. */
  get namespaceUri() {
    const colon = this.name.indexOf(':');
    const declaration = colon >= 0 ? 'xmlns:' + this.name.substring(0, colon) : 'xmlns';

    for (let node = this; node && node.type === 'element'; node = node.parent) {
      const attribute = node.attributes.find((a) => a.name === declaration);

      if (attribute) {
        return attribute.value;
      }
    }

    return '';
  }

  get elements() {
    return this.children.filter((child) => child.type === 'element');
  }

  appendChild(node) {
    node.parent = this;
    this.children.push(node);
    return node;
  }

  removeChild(node) {
    const index = this.children.indexOf(node);

    if (index >= 0) {
      this.children.splice(index, 1);
      node.parent = null;
    }
  }

  insertAfter(node, reference) {
    const index = this.children.indexOf(reference);
    node.parent = this;
    this.children.splice(index + 1, 0, node);
  }

  get previousSibling() {
    if (!this.parent) {
      return null;
    }

    const index = this.parent.children.indexOf(this);
    return index > 0 ? this.parent.children[index - 1] : null;
  }

  /** Concatenated text of all descendant text and CDATA nodes. */
  get innerText() {
    if (this.type === 'text' || this.type === 'cdata') {
      return this.value;
    }

    return this.children.map((child) => (child.type === 'comment' || child.type === 'pi' ? '' : child.innerText)).join('');
  }

  /** The node as System.Xml's OuterXml writes it. */
  get outerXml() {
    return serialize(this);
  }
}

export class XmlParseError extends Error {}

const PREDEFINED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Parses a document; throws XmlParseError when the text is not well-formed or has a DTD. */
export function parseXml(text) {
  const source = text.replace(/\r\n?/g, '\n');
  const document = new XmlNode('document');
  let position = 0;
  let current = document;

  const fail = (message) => {
    throw new XmlParseError(message + ' at position ' + position);
  };

  if (source.charCodeAt(0) === 0xfeff) {
    position = 1;
  }

  while (position < source.length) {
    if (source.startsWith('<?', position)) {
      const end = source.indexOf('?>', position + 2);

      if (end < 0) {
        fail('unterminated processing instruction');
      }

      const body = source.substring(position + 2, end);
      const space = body.search(/\s/);
      const target = space < 0 ? body : body.substring(0, space);
      const node = new XmlNode(target === 'xml' ? 'declaration' : 'pi', target);
      node.value = space < 0 ? '' : body.substring(space).trim();
      current.appendChild(node);
      position = end + 2;
    } else if (source.startsWith('<!--', position)) {
      const end = source.indexOf('-->', position + 4);

      if (end < 0) {
        fail('unterminated comment');
      }

      const node = new XmlNode('comment');
      node.value = source.substring(position + 4, end);
      current.appendChild(node);
      position = end + 3;
    } else if (source.startsWith('<![CDATA[', position)) {
      const end = source.indexOf(']]>', position + 9);

      if (end < 0) {
        fail('unterminated CDATA section');
      }

      const node = new XmlNode('cdata');
      node.value = source.substring(position + 9, end);
      current.appendChild(node);
      position = end + 3;
    } else if (source.startsWith('<!', position)) {
      fail('DTDs are not allowed');
    } else if (source.startsWith('</', position)) {
      const end = source.indexOf('>', position);

      if (end < 0) {
        fail('unterminated end tag');
      }

      const name = source.substring(position + 2, end).trim();

      if (current.type !== 'element' || current.name !== name) {
        fail('unexpected end tag </' + name + '>');
      }

      current = current.parent;
      position = end + 1;
    } else if (source[position] === '<') {
      position = readStartTag();
    } else {
      const end = source.indexOf('<', position);
      const raw = source.substring(position, end < 0 ? source.length : end);

      if (current === document) {
        if (raw.trim().length > 0) {
          fail('text outside the root element');
        }
      } else {
        const node = new XmlNode('text');
        node.value = decode(raw, false, fail);
        current.appendChild(node);
      }

      position = end < 0 ? source.length : end;
    }
  }

  if (current !== document) {
    fail('unclosed element <' + current.name + '>');
  }

  if (!document.documentElement) {
    fail('no root element');
  }

  return document;

  function readStartTag() {
    const nameMatch = /^<([^\s/>]+)/.exec(source.substring(position, position + 300));

    if (!nameMatch) {
      fail('bad start tag');
    }

    if (current === document && document.documentElement) {
      fail('a second root element');
    }

    const element = new XmlNode('element', nameMatch[1]);
    let index = position + nameMatch[0].length;

    for (;;) {
      while (index < source.length && /\s/.test(source[index])) {
        index++;
      }

      if (source.startsWith('/>', index)) {
        current.appendChild(element);
        return index + 2;
      }

      if (source[index] === '>') {
        current.appendChild(element);
        current = element;
        return index + 1;
      }

      const attribute = /^([^\s=/>]+)\s*=\s*(["'])/.exec(source.substring(index, index + 300));

      if (!attribute) {
        position = index;
        fail('bad attribute');
      }

      const valueStart = index + attribute[0].length;
      const valueEnd = source.indexOf(attribute[2], valueStart);

      if (valueEnd < 0) {
        position = index;
        fail('unterminated attribute value');
      }

      element.attributes.push({ name: attribute[1], value: decode(source.substring(valueStart, valueEnd), true, fail) });
      index = valueEnd + 1;
    }
  }
}

/** Resolves entity and character references; in attribute values literal tab and line feed become spaces. */
function decode(raw, attribute, fail) {
  let text = attribute ? raw.replace(/[\t\n]/g, ' ') : raw;

  if (text.indexOf('&') < 0) {
    return text;
  }

  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (match, reference) => {
    if (reference[0] === '#') {
      const code = reference[1] === 'x' ? parseInt(reference.substring(2), 16) : parseInt(reference.substring(1), 10);
      return String.fromCodePoint(code);
    }

    if (Object.prototype.hasOwnProperty.call(PREDEFINED, reference)) {
      return PREDEFINED[reference];
    }

    fail('unknown entity &' + reference + ';');
    return match;
  });
}

/** Parses, or returns null when the text is empty or not well-formed. */
export function tryParseXml(text) {
  if (text == null || text.trim().length === 0) {
    return null;
  }

  try {
    return parseXml(text.trim());
  } catch (error) {
    if (error instanceof XmlParseError) {
      return null;
    }

    throw error;
  }
}

/** XmlDocument.OuterXml: <a x="1" />, text with &amp; &lt; &gt;, attributes with &amp; &lt; &quot;. */
function serialize(node) {
  switch (node.type) {
    case 'document':
      return node.children.map(serialize).join('');
    case 'declaration':
    case 'pi':
      return '<?' + node.name + (node.value ? ' ' + node.value : '') + '?>';
    case 'comment':
      return '<!--' + node.value + '-->';
    case 'cdata':
      return '<![CDATA[' + node.value + ']]>';
    case 'text':
      return escapeText(node.value);
    default: {
      const attributes = node.attributes.map((a) => ' ' + a.name + '="' + escapeAttribute(a.value) + '"').join('');

      if (node.children.length === 0) {
        return '<' + node.name + attributes + ' />';
      }

      return '<' + node.name + attributes + '>' + node.children.map(serialize).join('') + '</' + node.name + '>';
    }
  }
}

function escapeText(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
}

function escapeAttribute(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\r/g, '&#xD;')
    .replace(/\n/g, '&#xA;')
    .replace(/\t/g, '&#x9;');
}
