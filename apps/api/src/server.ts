import { createServer } from 'node:http';
import { LocalControlPlane } from './control-plane.js';
const api = new LocalControlPlane();
createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ ok: true, service: 'joy-media-api', controlPlane: Boolean(api) }),
    );
    return;
  }
  response.writeHead(404).end();
}).listen(Number(process.env.JOY_MEDIA_API_PORT ?? 8790));
console.log('JOY Media API listening');
