// The page: enter a transaction of the MII server the page comes from, X-Ray it, copy or download the C# file.
import { CatalogSource, SourceError, ObjectPath } from './sources.js';
import { DependencyResolver } from './resolver.js';
import { generateCode } from './codefile.js';
import { RUNTIME_SOURCE } from './runtime.js';
import { loadStaticContent } from './staticfiles.js';

const RECENT_KEY = 'mii-x-ray.recent';
const $ = (id) => document.getElementById(id);

const state = { source: null, result: null, busy: false };

function readRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch (error) {
    return [];
  }
}

function remember(path) {
  const recent = [path, ...readRecent().filter((item) => item.toLowerCase() !== path.toLowerCase())].slice(0, 12);

  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch (error) {
    // private mode or blocked storage: the list just stays empty
  }

  showRecent();
}

function showRecent() {
  $('recent').replaceChildren(...readRecent().map((path) => Object.assign(document.createElement('option'), { value: path })));
}

function setStatus(text, kind) {
  const status = $('status');
  status.textContent = text;
  status.className = 'status ' + (kind || '');
}

function onServer() {
  return /^https?:$/.test(location.protocol);
}

function currentSource() {
  if (!state.source) {
    state.source = new CatalogSource(location.origin);
  }

  return state.source;
}

async function xray() {
  if (state.busy) {
    return;
  }

  const path = ObjectPath.normalize($('transaction').value);
  const source = currentSource();
  $('similar').replaceChildren();

  if (path.length === 0) {
    setStatus('Enter a transaction or folder path, e.g. PROJECT/Folder/trxName or PROJECT/Folder.', 'warning');
    return;
  }

  state.busy = true;
  $('run').disabled = true;
  let loaded = 0;
  setStatus('Loading ' + path + ' …');

  try {
    await source.checkConnection();
    const resolver = new DependencyResolver(source, (message) => {
      if (message.startsWith('loaded')) {
        loaded++;
        setStatus('Loading ' + path + ' … ' + loaded + ' object' + (loaded === 1 ? '' : 's'));
      }
    });
    const folder = await source.isFolder(path);
    const graph = folder ? await resolver.resolveFolder(path, await source.folderObjects(path)) : await resolver.resolve(path);

    if (!graph) {
      setStatus(folder ? 'The folder ' + path + ' contains no transaction or query template.' : path + ' was not found or is no transaction.', 'error');

      if (folder) {
        return;
      }

      const similar = await source.findSimilar(path, 8);
      $('similar').replaceChildren(...similar.map((candidate) => {
        const button = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: candidate });
        button.addEventListener('click', () => {
          $('transaction').value = candidate;
          xray();
        });
        return button;
      }));
      return;
    }

    setStatus('Loading web files and shared properties …');
    await loadStaticContent(graph, source, () => {});
    state.result = generateCode(graph, source.description, RUNTIME_SOURCE, new Date());
    remember(path);
    showResult();
    setStatus('');
  } catch (error) {
    if (error instanceof SourceError) {
      setStatus(error.message + ' ' + error.hint, 'error');
    } else {
      setStatus('Unexpected error: ' + error.message, 'error');
      console.error(error);
    }
  } finally {
    state.busy = false;
    $('run').disabled = false;
  }
}

function showResult() {
  const result = state.result;
  const parts = [result.transactionCount + ' transaction' + (result.transactionCount === 1 ? '' : 's'), result.queryCount + ' quer' + (result.queryCount === 1 ? 'y' : 'ies')];

  if (result.folder !== null) {
    parts.unshift('folder ' + result.folder);
  }

  if (result.missing.length > 0) {
    parts.push(result.missing.length + ' not found');
  }

  if (result.notes.length > 0) {
    parts.push(result.notes.length + ' note' + (result.notes.length === 1 ? '' : 's'));
  }

  $('result-name').textContent = result.rootName + '.xray.cs';
  $('result-facts').textContent = parts.join(' · ') + ' · ' + Math.round(result.code.length / 1024) + ' KB';
  $('code').textContent = result.code;
  $('result').hidden = false;
}

async function copy() {
  try {
    await navigator.clipboard.writeText(state.result.code);
    setStatus('Copied.', 'success');
  } catch (error) {
    setStatus('The browser did not allow copying; use Download.', 'warning');
  }
}

function download() {
  const blob = new Blob(['﻿' + state.result.code], { type: 'text/plain;charset=utf-8' });
  save(blob, state.result.rootName + '.xray.cs');
}

function save(blob, name) {
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function start() {
  $('run').addEventListener('click', xray);
  $('transaction').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      xray();
    }
  });
  $('copy').addEventListener('click', copy);
  $('download').addEventListener('click', download);  showRecent();

  if (!onServer()) {
    // opened as a file: there is no MII server to read from
    $('server-hint').hidden = false;
    $('run').disabled = true;
    $('transaction').disabled = true;
    return;
  }

  $('transaction').focus();
}

start();
