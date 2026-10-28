// The raw side of an X-Ray: every object exactly as the source returned it, the static files the transactions name
// and the shared properties of the projects involved, packed as one ZIP in the layout of an MII project.
import { literalLinkedValue, linkedExpression } from './resolver.js';
import { MiiQueryKind } from './model.js';

const EXTENSIONS = {
  Transaction: '.trx', SQLQuery: '.tqsq', XacuteQuery: '.tqxc', XMLQuery: '.tqxm', MDOQuery: '.tqmd', TagQuery: '.tqta',
  PCoQuery: '.tqpc', AlarmQuery: '.tqal', AggregateQuery: '.tqag', CatalogQuery: '.tqet', KPIQuery: '.tqkp', OLAPQuery: '.tqol',
};

// properties that name a file: the stylesheet of an XSL transformation, the document of an XML loader, the schema of
// an XSD validation
const FILE_PROPERTIES = { XSLTransform: ['Transform'], XmlLoader: ['SourceUrl'], XSDValidation: ['XSDURL'] };

/** The MII path of the object with the extension of its class (root element). */
export function rawObjectPath(path, rootName) {
  return path + (EXTENSIONS[rootName] || '.xml');
}

/** The Catalog path (Project/WEB/...) of a web file reference: db://P/WEB/x, /XMII/CM/P/x, http(s)://host/XMII/CM/P/x
 * or P/WEB/x. Null for everything else (servlet URLs, other servers, expressions). */
export function webFilePath(reference) {
  let text = (reference || '').trim().replace(/\\/g, '/').replace(/[?#].*$/, '');
  let match = /^db:\/\/(.+)$/i.exec(text);

  if (match) {
    text = match[1];
  } else {
    match = /^(?:https?:\/\/[^/]+)?\/XMII\/CM\/([^/]+)\/(.+)$/i.exec(text);

    if (match) {
      text = match[1] + '/WEB/' + match[2];
    }
  }

  text = text.replace(/^\/+/, '');
  return /^[^/:]+\/WEB\/[^:]+[^/]$/i.test(text) ? text : null;
}

/** The file references of the graph: { file, owner, use, value } with file = Catalog path, or null when the value is
 * no web file or is computed at runtime. */
export function fileReferences(graph) {
  const result = [];

  for (const transaction of graph.transactions) {
    for (const action of transaction.actions.values()) {
      for (const property of FILE_PROPERTIES[action.actionType] || []) {
        const linked = linkedExpression(transaction, action.name, property);
        const value = linked === null ? action.static(property) : literalLinkedValue(transaction, action.name, property);

        if (value === null) {
          result.push({ file: null, owner: transaction.path, use: action.name + '.' + property, value: linked });
        } else if (value.trim().length > 0) {
          result.push({ file: webFilePath(value), owner: transaction.path, use: action.name + '.' + property, value });
        }
      }
    }
  }

  for (const query of graph.queries) {
    if (query.kind === MiiQueryKind.Xml && query.url.trim().length > 0) {
      result.push({ file: webFilePath(query.url), owner: query.path, use: 'URL', value: query.url });
    }
  }

  return result;
}

/** Collects the ZIP entries { path, text }: the loaded objects, the referenced web files and per project the shared
 * properties (definitions with default values; the running values where the server returns them). */
export async function collectRawFiles(graph, source, progress) {
  const entries = [];
  const taken = new Set();
  const manifest = [];
  const add = (path, text) => {
    if (!taken.has(path.toLowerCase())) {
      taken.add(path.toLowerCase());
      entries.push({ path, text });
    }
  };

  for (const object of graph.rawObjects) {
    add(rawObjectPath(object.path, object.rootName), object.text);
  }

  const references = fileReferences(graph);

  for (const reference of references) {
    if (reference.file === null || taken.has(reference.file.toLowerCase())) {
      continue;
    }

    const text = typeof source.loadFile === 'function' ? await source.loadFile(reference.file) : null;

    if (text === null) {
      manifest.push('not found: ' + reference.file + ' (' + reference.owner + ' ' + reference.use + ')');
    } else {
      add(reference.file, text);
      progress('loaded ' + reference.file);
    }
  }

  for (const reference of references.filter((item) => item.file === null)) {
    manifest.push('not a web file or computed at runtime: ' + reference.owner + ' ' + reference.use + ' = ' + reference.value);
  }

  const projects = [...new Set(graph.rawObjects.map((object) => object.path.split('/')[0]))].sort();

  for (const project of projects) {
    const definitions = typeof source.loadFile === 'function' ? await source.loadFile(project + '/META-INF/SharedProperties.mem') : null;

    if (definitions === null) {
      manifest.push('not found: ' + project + '/META-INF/SharedProperties.mem');
    } else {
      add(project + '/META-INF/SharedProperties.mem', definitions);
    }

    const running = typeof source.loadRuntimeProperties === 'function' ? await source.loadRuntimeProperties(project) : null;

    if (running !== null) {
      add(project + '/META-INF/SharedProperties.runtime.xml', running);
    }
  }

  for (const missing of graph.missing) {
    manifest.push('not found: ' + missing);
  }

  const lines = [
    'MII X-Ray raw export',
    'Source: ' + source.description,
    '',
    'Every object as the source returned it, by MII path. <Project>/WEB/... are web files the transactions name,',
    '<Project>/META-INF/SharedProperties.mem the shared property definitions with default values,',
    'SharedProperties.runtime.xml the running values (Catalog GetRuntimePropertyList) where the server returns them.',
    '',
    'Files:',
    ...entries.map((entry) => '  ' + entry.path),
  ];

  if (manifest.length > 0) {
    lines.push('', 'Not included:', ...manifest.map((line) => '  ' + line));
  }

  entries.push({ path: 'xray-manifest.txt', text: lines.join('\r\n') + '\r\n' });
  return entries;
}

/** A ZIP archive (stored, no compression) of { path, text } entries; names and contents as UTF-8. */
export function buildZip(entries, date) {
  const encoder = new TextEncoder();
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const data = encoder.encode(entry.text);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    locals.push(new Uint8Array(local.buffer), name, data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(12, time, true);
    central.setUint16(14, day, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), name);
    offset += 30 + name.length + data.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let position = 0;

  for (const part of parts) {
    result.set(part, position);
    position += part.length;
  }

  return result;
}

let crcTable = null;

function crc32(bytes) {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);

    for (let n = 0; n < 256; n++) {
      let c = n;

      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }

      crcTable[n] = c >>> 0;
    }
  }

  let crc = 0xffffffff;

  for (let index = 0; index < bytes.length; index++) {
    crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}
