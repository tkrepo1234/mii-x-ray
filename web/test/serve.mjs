// A stand-in for the MII web server to try the page locally: serves web/dist/mii-x-ray.html under /XMII/CM/XRay/ and
// forwards /XMII/Catalog to an MII server (or the MUD mock catalog), adding the login the way a signed-in session does.
//   node web/test/serve.mjs [port] [catalog base url] [user:password]
//   node web/test/serve.mjs 5300 http://localhost:50100 dev:dev
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [port = '5300', catalog = 'http://localhost:50100', login = 'dev:dev'] = process.argv.slice(2);
const page = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'mii-x-ray.html');
const authorization = 'Basic ' + Buffer.from(login).toString('base64');

createServer(async (request, response) => {
  if (request.url.startsWith('/XMII/Catalog')) {
    const chunks = [];

    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const answer = await fetch(catalog + request.url, {
      method: request.method,
      headers: { 'Content-Type': request.headers['content-type'] || 'application/x-www-form-urlencoded', Authorization: authorization },
      body: request.method === 'POST' ? Buffer.concat(chunks) : undefined,
    });
    response.writeHead(answer.status, { 'Content-Type': answer.headers.get('content-type') || 'text/xml' });
    response.end(Buffer.from(await answer.arrayBuffer()));
    return;
  }

  if (request.url.startsWith('/XMII/CM/XRay/mii-x-ray.html')) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(readFileSync(page));
    return;
  }

  response.writeHead(404, { 'Content-Type': 'text/plain' });
  response.end('not found');
}).listen(Number(port), () => console.log('http://localhost:' + port + '/XMII/CM/XRay/mii-x-ray.html -> ' + catalog));
