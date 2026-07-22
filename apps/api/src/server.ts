import { LocalControlPlane } from './control-plane.js';
import { createControlPlaneHttpServer } from './http-server.js';

const api = new LocalControlPlane();
createControlPlaneHttpServer({
  controlPlane: api,
  authentication: {
    // The real shared-JOY identity adapter must be supplied before /v1 routes
    // are activated in a deployed service. Health remains intentionally public.
    authenticate: () => undefined,
  },
}).listen(Number(process.env.JOY_MEDIA_API_PORT ?? 8790));
console.log('JOY Media API listening');
