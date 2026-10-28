// Where MII objects come from: the Catalog service of the MII server the page runs on, or an export folder.
import { MiiXml } from './model.js';
import { tryParseXml } from './xml.js';

const KNOWN_EXTENSIONS = ['.trx', '.tqsq', '.tqxc', '.tqmd', '.tqxm'];

/** MII object names: forward slashes, no leading or trailing slash, no file extension. */
export const ObjectPath = {
  normalize(path) {
    if (path == null) {
      return '';
    }

    let result = path.trim().replace(/^"+|"+$/g, '').replace(/\\/g, '/');

    while (result.includes('//')) {
      result = result.replace(/\/\//g, '/');
    }

    result = result.replace(/^\/+|\/+$/g, '');

    for (const extension of KNOWN_EXTENSIONS) {
      if (result.toLowerCase().endsWith(extension)) {
        return result.substring(0, result.length - extension.length);
      }
    }

    return result;
  },

  folder(path) {
    const normalized = ObjectPath.normalize(path);
    const slash = normalized.lastIndexOf('/');
    return slash > 0 ? normalized.substring(0, slash) : '';
  },

  leaf(path) {
    const normalized = ObjectPath.normalize(path);
    const slash = normalized.lastIndexOf('/');
    return slash >= 0 ? normalized.substring(slash + 1) : normalized;
  },

  isKnownExtension(name) {
    const lower = name.toLowerCase();
    return KNOWN_EXTENSIONS.some((extension) => lower.endsWith(extension));
  },
};

/** A problem with the source and what the user can do about it. */
export class SourceError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

/** "Did you mean": same leaf name first, then leaf names that contain the searched name or are a typo away. */
export function findSimilar(candidates, objectPath, maximum) {
  const leaf = ObjectPath.leaf(objectPath).toLowerCase();
  const exact = [];
  const partial = [];

  if (leaf.length === 0) {
    return exact;
  }

  for (const candidate of candidates) {
    const candidateLeaf = ObjectPath.leaf(candidate).toLowerCase();

    if (candidateLeaf === leaf) {
      exact.push(candidate);
    } else if (candidateLeaf.includes(leaf) || (candidateLeaf.length >= 4 && leaf.includes(candidateLeaf))
      || editDistance(candidateLeaf, leaf) <= Math.max(2, Math.floor(leaf.length / 6))) {
      partial.push(candidate);
    }
  }

  return exact.concat(partial).slice(0, maximum);
}

/** Levenshtein distance: how many characters to insert, delete or change. */
export function editDistance(first, second) {
  let previous = Array.from({ length: second.length + 1 }, (unused, index) => index);
  let current = new Array(second.length + 1);

  for (let i = 1; i <= first.length; i++) {
    current[0] = i;

    for (let j = 1; j <= second.length; j++) {
      const change = first[i - 1] === second[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + change);
    }

    [previous, current] = [current, previous];
  }

  return previous[second.length];
}

/** The Catalog service (/XMII/Catalog) of the MII server the page comes from, with the session of the signed-in
 * user. MII may protect POST requests with a CSRF token; the token is fetched once when the server asks for it. */
export class CatalogSource {
  constructor(baseUrl) {
    this._url = (baseUrl || '').replace(/\/+$/, '') + '/XMII/Catalog';
    this._csrfToken = null;
    this._loaded = new Map(); // lower-case path -> text, filled by prefetch
    this._listed = new Set(); // lower-case paths a folder listing has shown: they exist
    this.description = 'MII ' + (baseUrl || location.origin);
  }

  async checkConnection() {
    await this._exists('MiiXRay/ConnectionCheck/doesNotExist');
  }

  /** Loads the transactions among items ({ path, type }) with few requests (Catalog LoadMultipleObjects, which works
   * only for Class=Transaction). Class n belongs to ObjectName n. One missing object makes MII answer a FatalError and
   * load nothing, lists of different length give an empty Files document: such a batch is simply left out, and load()
   * reads its objects one by one. */
  async prefetch(items) {
    const wanted = [];

    for (const item of items) {
      const path = ObjectPath.normalize(item.path);
      const key = path.toLowerCase();

      // LoadMultipleObjects works only for Class=Transaction (Tim, 2026-10-28); query templates load one by one
      if (path.length > 0 && !path.includes(',') && item.type === 'Transaction' && !this._loaded.has(key) && !wanted.some((other) => other.key === key)) {
        wanted.push({ path, key, type: item.type });
      }
    }

    for (let start = 0; start < wanted.length; start += PREFETCH_BATCH) {
      await this._loadBatch(wanted.slice(start, start + PREFETCH_BATCH));
    }
  }

  /** One LoadMultipleObjects call; after a FatalError (an object is missing) each half is tried again, so the missing
   * object ends up alone and only it is left to load(). */
  async _loadBatch(batch) {
    const text = await this._post({
      Mode: 'LoadMultipleObjects',
      Class: batch.map((item) => item.type).join(','),
      ObjectName: batch.map((item) => item.path).join(','),
      TemporaryFile: 'false',
      _: String(Date.now()),
    });
    const answer = tryParseXml(text);

    if (!answer) {
      return;
    }

    if (answer.documentElement.localName === 'Rowsets') {
      if (batch.length > 1) {
        const half = Math.ceil(batch.length / 2);
        await this._loadBatch(batch.slice(0, half));
        await this._loadBatch(batch.slice(half));
      }

      return;
    }

    const files = answer.documentElement.localName === 'Files' ? MiiXml.children(answer.documentElement, 'File') : [];

    if (files.length !== batch.length) {
      return;
    }

    batch.forEach((item, index) => {
      const content = decodeBase64(files[index].innerText.trim());

      if (content.trim().length > 0) {
        this._loaded.set(item.key, content);
      }
    });
  }

  async load(objectPath) {
    const path = ObjectPath.normalize(objectPath);
    const prefetched = this._loaded.get(path.toLowerCase());

    if (prefetched !== undefined) {
      return { canonicalPath: path, text: prefetched };
    }

    if (path.length === 0 || (!this._listed.has(path.toLowerCase()) && !(await this._exists(path)))) {
      return null;
    }

    const text = await this._post({ Mode: 'Load', ObjectName: path, 'Content-Type': 'text/xml', _: String(Date.now()) });
    const answer = text.includes('FatalError') ? tryParseXml(text) : null;

    if (answer && answer.documentElement.localName === 'Rowsets') {
      throwOnFatalError(answer);
    }

    return { canonicalPath: path, text };
  }

  async findSimilar(objectPath, maximum) {
    let folder = ObjectPath.folder(objectPath);
    let candidates = [];

    while (folder.length > 0 && candidates.length === 0) {
      try {
        candidates = await this.listObjects(folder);
      } catch (error) {
        if (!(error instanceof SourceError)) {
          throw error;
        }
      }

      folder = ObjectPath.folder(folder);
    }

    return findSimilar(candidates, objectPath, maximum);
  }

  /** Object paths below a folder (recursive). */
  async listObjects(folder) {
    return (await this.folderObjects(folder)).map((entry) => entry.path);
  }

  /** Whether a path names a folder (Catalog Exists answers 1 for an object, 2 for a folder, 0 for nothing). */
  async isFolder(objectPath) {
    const path = ObjectPath.normalize(objectPath);
    return path.length > 0 && (await this._existsCode(path)) === '2';
  }

  /** The transactions and query templates below a folder (recursive) as { path, type }; type is 'Transaction' or
   * 'QueryTemplate' (Catalog LoadFilesInsideFolderAndSubfolders, which lists no web files). */
  async folderObjects(folder) {
    const document = parseAnswer(await this._post({ Mode: 'LoadFilesInsideFolderAndSubfolders', Folder: ObjectPath.normalize(folder), 'Content-Type': 'text/xml' }));
    const result = [];

    for (const row of descendants(document, 'Row')) {
      const filePath = MiiXml.childText(row, 'FilePath').trim().replace(/^\/+|\/+$/g, '');
      const objectName = MiiXml.childText(row, 'ObjectName').trim();

      if (objectName.length > 0) {
        const type = MiiXml.childText(row, 'Type').trim();
        this._listed.add(ObjectPath.normalize(filePath.length > 0 ? filePath + '/' + objectName : objectName).toLowerCase());
        result.push({ path: ObjectPath.normalize(filePath.length > 0 ? filePath + '/' + objectName : objectName), type: type.length > 0 ? type : typeOfName(objectName) });
      }
    }

    return result;
  }

  async _exists(path) {
    return (await this._existsCode(path)) === '1';
  }

  async _existsCode(path) {
    const document = parseAnswer(await this._post({ Mode: 'Exists', ObjectName: path, 'Content-Type': 'text/xml', _: String(Date.now()) }));
    const messages = descendants(document, 'Message');
    return messages.length > 0 ? messages[0].innerText.trim() : '0';
  }

  async _post(form, retried) {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Cache-Control': 'no-cache' };

    if (this._csrfToken) {
      headers['X-CSRF-Token'] = this._csrfToken;
    }

    let response;

    try {
      response = await fetch(this._url, { method: 'POST', headers, body: new URLSearchParams(form).toString(), credentials: 'same-origin' });
    } catch (error) {
      throw new SourceError('The MII server cannot be reached: ' + error.message, 'Check the network connection and that the page is opened from the MII server.');
    }

    if (response.status === 403 && !retried && (response.headers.get('X-CSRF-Token') || '').toLowerCase() === 'required') {
      const probe = await fetch(this._url, { method: 'GET', headers: { 'X-CSRF-Token': 'Fetch' }, credentials: 'same-origin' });
      this._csrfToken = probe.headers.get('X-CSRF-Token');
      return this._post(form, true);
    }

    if (response.status === 401 || response.status === 403) {
      throw new SourceError('MII refused the request (HTTP ' + response.status + ').',
        'The user needs a role with access to the Catalog service (e.g. SAP_XMII_Developer). Sign in again if the session expired.');
    }

    if (!response.ok) {
      throw new SourceError('The Catalog service answered HTTP ' + response.status + '.', 'Open the page from the MII server (…/XMII/CM/…) and try again.');
    }

    return response.text();
  }
}

const PREFETCH_BATCH = 40;

/** Base64 of UTF-8 bytes as text. */
function decodeBase64(text) {
  const binary = atob(text.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
}

/** The object type by file extension, for answers without a Type column. */
export function typeOfName(name) {
  return name.toLowerCase().endsWith('.trx') ? 'Transaction' : ObjectPath.isKnownExtension(name) ? 'QueryTemplate' : '';
}

function parseAnswer(text) {
  const document = tryParseXml(text);

  if (!document) {
    throw new SourceError('The server answered with something that is not XML.', 'Open the page from the MII server itself.');
  }

  throwOnFatalError(document);
  return document;
}

function throwOnFatalError(document) {
  if (!document) {
    return;
  }

  const fatal = descendants(document, 'FatalError');

  if (fatal.length > 0) {
    throw new SourceError('MII reports: ' + fatal[0].innerText.trim(),
      'The user needs a role with access to the Catalog service (e.g. SAP_XMII_Developer) and read access to the project.');
  }
}

function descendants(node, name) {
  const result = [];
  const walk = (current) => {
    for (const child of current.children) {
      if (child.type === 'element') {
        if (child.localName === name) {
          result.push(child);
        }

        walk(child);
      }
    }
  };
  walk(node);
  return result;
}
