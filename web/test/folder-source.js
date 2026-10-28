// An export folder as source - for tests and the equivalence check only, not part of the page.
import { ObjectPath, SourceError, findSimilar, typeOfName } from '../src/sources.js';

/** An export folder: a list of { path, read() } with the paths relative to the chosen folder. A logical path is
 * resolved by its longest unique suffix (export folders carry the project name, references the internal one). */
export class FolderSource {
  constructor(name, files) {
    this.description = 'export folder ' + name;
    this._bySuffix = new Map();
    this._allPaths = [];
    this._everyFile = files;
    const sorted = files.filter((file) => ObjectPath.isKnownExtension(file.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    for (const file of sorted) {
      const relative = ObjectPath.normalize(file.path);
      this._allPaths.push(relative);
      const parts = relative.split('/');

      for (let count = 1; count <= parts.length; count++) {
        const key = parts.slice(parts.length - count).join('/').toLowerCase();

        if (!this._bySuffix.has(key)) {
          this._bySuffix.set(key, []);
        }

        this._bySuffix.get(key).push({ file, relative });
      }
    }
  }

  async checkConnection() {
    if (this._allPaths.length === 0) {
      throw new SourceError('The folder contains no MII objects (.trx, .tqsq, .tqmd, .tqxm, .tqxc).',
        'Choose the folder of an unpacked project export.');
    }
  }

  async load(objectPath) {
    const path = ObjectPath.normalize(objectPath);

    if (path.length === 0) {
      return null;
    }

    const parts = path.split('/');

    for (let count = parts.length; count >= 1; count--) {
      const hits = this._bySuffix.get(parts.slice(parts.length - count).join('/').toLowerCase());

      if (hits) {
        return hits.length === 1 ? { canonicalPath: hits[0].relative, text: await hits[0].file.read() } : null;
      }
    }

    return null;
  }

  /** A web or Meta-Inf file by its Catalog path (Project/WEB/...), found by its unique path suffix. */
  async loadFile(filePath) {
    const wanted = '/' + filePath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    const hits = this._everyFile.filter((file) => ('/' + file.path.replace(/\\/g, '/').toLowerCase()).endsWith(wanted));
    return hits.length === 1 ? hits[0].read() : null;
  }

  async findSimilar(objectPath, maximum) {
    return findSimilar(this._allPaths, objectPath, maximum);
  }

  async isFolder(objectPath) {
    const prefix = ObjectPath.normalize(objectPath).toLowerCase() + '/';
    return prefix.length > 1 && this._allPaths.some((path) => path.toLowerCase().startsWith(prefix));
  }

  /** Like the Catalog's LoadFilesInsideFolderAndSubfolders: { path, type } of every object below the folder. */
  async folderObjects(folder) {
    const prefix = ObjectPath.normalize(folder).toLowerCase() + '/';
    return this._allPaths.filter((path) => path.toLowerCase().startsWith(prefix)).map((path) => ({
      path,
      type: typeOfName(this._bySuffix.get(path.toLowerCase())[0].file.path),
    }));
  }

  /** Every transaction of the folder (relative paths). */
  transactions() {
    return this._allPaths.filter((path) => this._bySuffix.get(path.toLowerCase())[0].file.path.toLowerCase().endsWith('.trx'));
  }
}
