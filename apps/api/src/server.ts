import { LocalControlPlane } from './control-plane.js';
import { createControlPlaneHttpServer } from './http-server.js';
import { JoyIdentityVerifier } from './joy-identity.js';

const api = new LocalControlPlane();
const identity = createIdentityVerifier();
createControlPlaneHttpServer({
  controlPlane: api,
  authentication: {
    // The real shared-JOY identity adapter must be supplied before /v1 routes
    // are activated in a deployed service. Health remains intentionally public.
    authenticate: (request) => identity?.authenticate(request),
  },
}).listen(Number(process.env.JOY_MEDIA_API_PORT ?? 8790));
console.log('JOY Media API listening');

function createIdentityVerifier(): JoyIdentityVerifier | undefined {
  const issuer = process.env.JOY_MEDIA_IDENTITY_ISSUER;
  const audience = process.env.JOY_MEDIA_IDENTITY_AUDIENCE;
  const jwksUrl = process.env.JOY_MEDIA_IDENTITY_JWKS_URL;
  if (issuer === undefined || audience === undefined || jwksUrl === undefined) return undefined;
  return new JoyIdentityVerifier({ issuer, audience, jwksUrl });
}
