// Loads the root transaction and follows every static transaction and query reference recursively.
import { ObjectReader, MiiQueryKind } from './model.js';
import { ObjectPath } from './sources.js';
import { parseXml, XmlParseError } from './xml.js';

/** Everything one X-Ray run needs: the root transaction and every transaction and query it reaches. */
export class ObjectGraph {
  constructor() {
    this.root = null;
    this.roots = []; // the public methods: the root transaction, or every transaction of the folder
    this.folder = null; // the folder of a folder X-Ray
    this.folderQueries = []; // the query templates of that folder
    this.transactions = []; // discovery order, root first
    this.queries = [];
    this.transactionsByReference = new Map(); // lower-case normalized reference -> transaction
    this.queriesByReference = new Map();
    this.missing = [];
  }

  findTransaction(reference) {
    return this.transactionsByReference.get(ObjectPath.normalize(reference).toLowerCase()) || null;
  }

  findQuery(reference) {
    return this.queriesByReference.get(ObjectPath.normalize(reference).toLowerCase()) || null;
  }
}

const STRING_LITERAL = /^\s*"([^"\\]*)"\s*$/;

/** The expression of an incoming link to Action.Property; null when there is none. */
export function linkedExpression(owner, actionName, property) {
  for (const use of owner.allActionUses()) {
    if (use.name !== actionName) {
      continue;
    }

    for (const link of use.incoming) {
      if (link.to === actionName + '.' + property) {
        return link.from;
      }
    }
  }

  return null;
}

/** The value of an incoming link to Action.Property when it is a plain string literal; null otherwise. */
export function literalLinkedValue(owner, actionName, property) {
  for (const use of owner.allActionUses()) {
    if (use.name !== actionName) {
      continue;
    }

    for (const link of use.incoming) {
      if (link.to === actionName + '.' + property) {
        const match = STRING_LITERAL.exec(link.from);
        return match ? match[1] : null;
      }
    }
  }

  return null;
}

/** The transaction or query template an action uses as { path, type }; null when it uses none or names it at runtime. */
function referenceOf(owner, action) {
  if (action.actionType === 'TransactionCall') {
    // a literal link to TransactionName wins over the configured name; an expression leaves the callee open
    const linked = linkedExpression(owner, action.name, 'TransactionName');
    const name = linked === null ? action.static('TransactionName') : literalLinkedValue(owner, action.name, 'TransactionName') || '';
    return name.length > 0 ? { path: name, type: 'Transaction' } : null;
  }

  if (action.actionType === 'DynamicTransactionCall') {
    const name = literalLinkedValue(owner, action.name, 'TransactionName');
    return name !== null ? { path: name, type: 'Transaction' } : null;
  }

  if (action.hasProperty('QueryTemplate')) {
    let name = action.static('QueryTemplate');

    if (name.length === 0) {
      name = literalLinkedValue(owner, action.name, 'QueryTemplate');
    }

    return name ? { path: name, type: 'QueryTemplate' } : null;
  }

  return null;
}

export class DependencyResolver {
  constructor(source, progress) {
    this._source = source;
    this._progress = progress || (() => {});
    this._graph = new ObjectGraph();
    this._byCanonicalPath = new Map();
    this._pending = [];
  }

  /** The graph, or null when the root does not exist or is no transaction. */
  async resolve(rootPath) {
    const root = await this._loadTransaction(rootPath);

    if (!root) {
      return null;
    }

    this._graph.root = root;
    this._graph.roots = [root];
    await this._followPending();
    return this._graph;
  }

  /** A whole folder: every transaction and query template below it (entries { path, type } of the folder listing),
   * and everything they reach. Null when none of them can be read. */
  async resolveFolder(folder, entries) {
    const byPath = (a, b) => (a.path.toLowerCase() < b.path.toLowerCase() ? -1 : a.path.toLowerCase() > b.path.toLowerCase() ? 1 : 0);
    const sorted = entries.slice().sort(byPath);
    this._graph.folder = ObjectPath.normalize(folder);
    this._graph.roots = [];
    this._graph.folderQueries = [];
    await this._prefetch(sorted);

    for (const entry of sorted.filter((item) => item.type === 'Transaction')) {
      const transaction = await this._loadTransaction(entry.path);

      if (transaction && !this._graph.roots.includes(transaction)) {
        this._graph.roots.push(transaction);
      }
    }

    for (const entry of sorted.filter((item) => item.type !== 'Transaction')) {
      await this._loadQuery(entry.path);
      const query = this._graph.findQuery(entry.path);

      if (query && !this._graph.folderQueries.includes(query)) {
        this._graph.folderQueries.push(query);
      }
    }

    if (this._graph.roots.length === 0 && this._graph.folderQueries.length === 0) {
      return null;
    }

    this._graph.root = this._graph.roots.length > 0 ? this._graph.roots[0] : null;
    await this._followPending();
    return this._graph;
  }

  /** Wave by wave: the references of all pending transactions are fetched together, then followed in order. */
  async _followPending() {
    while (this._pending.length > 0) {
      const wave = this._pending.splice(0);
      await this._prefetch(wave.flatMap((transaction) => [...transaction.actions.values()].map((action) => referenceOf(transaction, action)).filter(Boolean)));

      for (const transaction of wave) {
        for (const action of transaction.actions.values()) {
          const reference = referenceOf(transaction, action);

          if (reference && reference.type === 'Transaction') {
            await this._loadTransaction(reference.path);
          } else if (reference) {
            await this._loadQuery(reference.path);
          }
        }
      }
    }
  }

  /** Lets a source that can load in batches fetch the objects not known yet. */
  async _prefetch(references) {
    if (typeof this._source.prefetch !== 'function') {
      return;
    }

    const unknown = references.filter((reference) => {
      const key = ObjectPath.normalize(reference.path);
      const lower = key.toLowerCase();
      return key.length > 0 && !this._graph.transactionsByReference.has(lower) && !this._graph.queriesByReference.has(lower) && !this._graph.missing.includes(key);
    });

    if (unknown.length > 0) {
      await this._source.prefetch(unknown);
    }
  }

  async _loadTransaction(reference) {
    const key = ObjectPath.normalize(reference);
    const known = this._graph.transactionsByReference.get(key.toLowerCase());

    if (known) {
      return known;
    }

    if (this._graph.missing.includes(key)) {
      return null;
    }

    const loaded = await this._loadObject(key);

    if (!(loaded && loaded.kind === 'transaction')) {
      this._remember(key, loaded);
      return null;
    }

    this._graph.transactionsByReference.set(key.toLowerCase(), loaded.value);
    return loaded.value;
  }

  async _loadQuery(reference) {
    const key = ObjectPath.normalize(reference);
    const lower = key.toLowerCase();

    if (this._graph.queriesByReference.has(lower) || this._graph.transactionsByReference.has(lower) || this._graph.missing.includes(key)) {
      return;
    }

    const loaded = await this._loadObject(key);

    if (!(loaded && loaded.kind === 'query')) {
      this._remember(key, loaded);
      return;
    }

    this._graph.queriesByReference.set(lower, loaded.value);
    const query = loaded.value;

    if (query.kind === MiiQueryKind.Xacute && query.xacuteTransaction.length > 0) {
      await this._loadTransaction(query.xacuteTransaction);
    }
  }

  _remember(key, loaded) {
    if (loaded && loaded.kind === 'transaction') {
      this._graph.transactionsByReference.set(key.toLowerCase(), loaded.value);
    } else if (loaded && loaded.kind === 'query') {
      this._graph.queriesByReference.set(key.toLowerCase(), loaded.value);
    } else if (!loaded && !this._graph.missing.includes(key)) {
      this._graph.missing.push(key);
    }
  }

  /** Loads and parses one object; the same file reached by two different references is parsed once. */
  async _loadObject(key) {
    const loaded = await this._source.load(key);

    if (!loaded) {
      this._progress('not found: ' + key);
      return null;
    }

    const existing = this._byCanonicalPath.get(loaded.canonicalPath.toLowerCase());

    if (existing) {
      return existing;
    }

    let document;

    try {
      document = parseXml(loaded.text);
    } catch (error) {
      if (error instanceof XmlParseError) {
        this._progress('not readable (' + error.message + '): ' + key);
        return null;
      }

      throw error;
    }

    let result;

    if (ObjectReader.isTransaction(document)) {
      const transaction = ObjectReader.readTransaction(key, document);
      this._graph.transactions.push(transaction);
      this._pending.push(transaction);
      result = { kind: 'transaction', value: transaction };
    } else {
      const query = ObjectReader.readQuery(key, document);
      this._graph.queries.push(query);
      result = { kind: 'query', value: query };
    }

    this._byCanonicalPath.set(loaded.canonicalPath.toLowerCase(), result);
    this._progress('loaded ' + key);
    return result;
  }
}
