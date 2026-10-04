import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function runClientKeySmoke(
  origin = 'http://127.0.0.1:8790',
  execute = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 6_000 }),
) {
  const parsedOrigin = new URL(origin);
  if (!['127.0.0.1', '::1', 'localhost', '[::1]'].includes(parsedOrigin.hostname)) {
    throw new Error('client-key smoke origin must be loopback');
  }

  function readClientKey(forwardedAddress) {
    const curlArgs = ['--silent', '--show-error', '--fail', '--max-time', '5'];
    if (forwardedAddress !== undefined) {
      curlArgs.push('--header', `X-Forwarded-For: ${forwardedAddress}`);
    }
    curlArgs.push(`${origin.replace(/\/$/u, '')}/internal/client-key`);
    const response = execute('curl', curlArgs);
    if (/\b(?:\d{1,3}\.){3}\d{1,3}\b|(?:^|[^\w])[0-9a-f]{0,4}:[0-9a-f:]+/iu.test(response)) {
      throw new Error('client-key diagnostic response contains an address');
    }
    const payload = JSON.parse(response);
    if (typeof payload.clientKey !== 'string' || !/^[a-f0-9]{64}$/u.test(payload.clientKey)) {
      throw new Error('client-key diagnostic response has an invalid key');
    }
    return payload.clientKey;
  }

  const first = readClientKey('198.51.100.71');
  const second = readClientKey('198.51.100.72');
  const loopback = readClientKey(undefined);
  const loopbackAgain = readClientKey(undefined);
  if (first === second || first === loopback || second === loopback || loopback !== loopbackAgain) {
    throw new Error('client-key diagnostic did not produce distinct client keys');
  }
  return 'CLIENT_KEY_SMOKE_OK distinct loopback keys';
}

function main(args) {
  const originIndex = args.indexOf('--origin');
  const origin = originIndex < 0 ? 'http://127.0.0.1:8790' : args[originIndex + 1];
  if (!origin || args.some((arg, index) => arg === '--origin' && index !== originIndex)) {
    throw new Error('usage: smoke-client-key.mjs [--origin http://127.0.0.1:8790]');
  }
  console.log(runClientKeySmoke(origin));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
