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
    this.description = 'MII ' + (baseUrl || location.origin);
  }

  async checkConnection() {
    await this._exists('MiiXRay/ConnectionCheck/doesNotExist');
  }

  async load(objectPath) {
    const path = ObjectPath.normalize(objectPath);

    if (path.length === 0 || !(await this._exists(path))) {
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
    const document = parseAnswer(await this._post({ Mode: 'LoadFilesInsideFolderAndSubfolders', Folder: folder, 'Content-Type': 'text/xml' }));
    const result = [];

    for (const row of descendants(document, 'Row')) {
      const filePath = MiiXml.childText(row, 'FilePath').trim().replace(/^\/+|\/+$/g, '');
      const objectName = MiiXml.childText(row, 'ObjectName').trim();

      if (objectName.length > 0) {
        result.push(ObjectPath.normalize(filePath.length > 0 ? filePath + '/' + objectName : objectName));
      }
    }

    return result;
  }

  async _exists(path) {
    const document = parseAnswer(await this._post({ Mode: 'Exists', ObjectName: path, 'Content-Type': 'text/xml', _: String(Date.now()) }));
    const messages = descendants(document, 'Message');
    return messages.length > 0 && messages[0].innerText.trim() === '1';
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
