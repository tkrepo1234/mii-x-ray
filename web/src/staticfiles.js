// What the transactions use besides transactions and queries: the web files they name (XSLT, XML, XSD) and the
// shared properties they read. Loaded once after the objects, so the generator can put them into the file.
import { literalLinkedValue, linkedExpression } from './resolver.js';
import { MiiQueryKind, MiiXml } from './model.js';
import { tryParseXml } from './xml.js';

// properties that name a file: the stylesheet of an XSL transformation, the document of an XML loader, the schema of
// an XSD validation
const FILE_PROPERTIES = { XSLTransform: ['Transform'], XmlLoader: ['SourceUrl'], XSDValidation: ['XSDURL'] };

const SHARED_PROPERTY = /\b(Inline|Persistent)\.([A-Za-z_][A-Za-z0-9_]*)/g;

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

/** The value of a file property as MII uses it: a literal link wins over the configured value; null when a link
 * computes it at runtime. */
export function fileReferenceValue(owner, action, property) {
  const linked = linkedExpression(owner, action.name, property);
  return linked === null ? action.static(property) : literalLinkedValue(owner, action.name, property);
}

/** Every web file the graph names, as Catalog paths. */
export function referencedFiles(graph) {
  const result = new Set();

  for (const transaction of graph.transactions) {
    for (const action of transaction.actions.values()) {
      for (const property of FILE_PROPERTIES[action.actionType] || []) {
        const path = webFilePath(fileReferenceValue(transaction, action, property));

        if (path !== null) {
          result.add(path);
        }
      }
    }
  }

  for (const query of graph.queries) {
    const path = query.kind === MiiQueryKind.Xml ? webFilePath(query.url) : null;

    if (path !== null) {
      result.add(path);
    }
  }

  return [...result].sort();
}

/** The shared properties the transactions read or write, as { project, name } (name with Inline./Persistent.). */
export function referencedSharedProperties(graph) {
  const result = new Map();

  for (const transaction of graph.transactions) {
    const project = transaction.path.split('/')[0];

    for (const use of transaction.allActionUses()) {
      for (const link of use.incoming.concat(use.outgoing)) {
        for (const text of [link.from, link.to]) {
          for (const match of (text || '').matchAll(SHARED_PROPERTY)) {
            result.set((project + '/' + match[0]).toLowerCase(), { project, name: match[0] });
          }
        }
      }
    }
  }

  return [...result.values()].sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
}

/** Loads the web files and the shared property definitions into the graph: graph.files (Catalog path -> text, null
 * when not found) and graph.sharedProperties ({ project, name, definition }, definition null when not found). */
export async function loadStaticContent(graph, source, progress) {
  graph.files = new Map();
  graph.sharedProperties = [];

  if (typeof source.loadFile !== 'function') {
    return;
  }

  for (const path of referencedFiles(graph)) {
    graph.files.set(path, await source.loadFile(path));
    progress('loaded ' + path);
  }

  const definitions = new Map();

  for (const reference of referencedSharedProperties(graph)) {
    if (!definitions.has(reference.project)) {
      definitions.set(reference.project, parseSharedProperties(await source.loadFile(reference.project + '/META-INF/SharedProperties.mem')));
    }

    const leaf = reference.name.substring(reference.name.indexOf('.') + 1);
    const project = definitions.get(reference.project);
    graph.sharedProperties.push({ ...reference, definition: project === null ? null : project.get(leaf.toLowerCase()) || null, projectLoaded: project !== null });
  }
}

/** SharedProperties.mem: lower-case name -> { attributes (name -> value), defaultValue }; null when not readable. */
function parseSharedProperties(text) {
  const document = text === null ? null : tryParseXml(text);

  if (!document || !document.documentElement) {
    return null;
  }

  const result = new Map();

  for (const property of MiiXml.children(document.documentElement, 'Property')) {
    result.set(property.getAttribute('Name').toLowerCase(), {
      attributes: property.attributes.map((attribute) => [attribute.name, attribute.value]),
      defaultValue: MiiXml.ownText(MiiXml.child(property, 'DefaultValue')),
    });
  }

  return result;
}
