import { isAbsolute, relative, resolve, sep } from 'node:path';

export const DESKTOP_TEST_MODE_FLAG = '--joy-media-test-mode';
export const DESKTOP_TEST_API_BASE_ENV = 'JOY_MEDIA_TEST_API_BASE_URL';
export const DESKTOP_TEST_DOWNLOAD_DIRECTORY_ENV = 'JOY_MEDIA_TEST_DOWNLOAD_DIRECTORY';
export const DESKTOP_TEST_API_BASE_ARGUMENT = '--joy-media-test-api-base-url=';

/**
 * Resolve an API endpoint for local desktop acceptance only. The default app
 * path never consults this environment variable, and explicit test mode can
 * only target an HTTP loopback origin with no path, credentials, query, or
 * fragment.
 */
export function resolveTestApiBaseUrl(options: {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}): string | undefined {
  if (!options.argv.includes(DESKTOP_TEST_MODE_FLAG)) return undefined;

  const configured = options.env[DESKTOP_TEST_API_BASE_ENV];
  if (configured === undefined) {
    throw new Error(`test mode requires ${DESKTOP_TEST_API_BASE_ENV}`);
  }

  let endpoint: URL;
  try {
    endpoint = new URL(configured);
  } catch {
    throw new Error(`${DESKTOP_TEST_API_BASE_ENV} must be a valid URL`);
  }

  const loopbackHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(endpoint.hostname);
  const cleanOrigin =
    endpoint.protocol === 'http:' &&
    loopbackHost &&
    endpoint.username === '' &&
    endpoint.password === '' &&
    (endpoint.pathname === '' || endpoint.pathname === '/') &&
    endpoint.search === '' &&
    endpoint.hash === '';
  if (!cleanOrigin) throw new Error('test mode endpoint must be a loopback HTTP origin');

  return endpoint.origin;
}

/**
 * Resolve the download destination used by packaged acceptance tests. The
 * directory must be an absolute child of Electron's isolated user-data path,
 * which prevents an acceptance run from writing into the owner's Downloads.
 */
export function resolveTestDownloadDirectory(options: {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly userDataDirectory: string;
}): string | undefined {
  if (!options.argv.includes(DESKTOP_TEST_MODE_FLAG)) return undefined;

  const configured = options.env[DESKTOP_TEST_DOWNLOAD_DIRECTORY_ENV];
  if (
    configured === undefined ||
    !isAbsolute(configured) ||
    !isAbsolute(options.userDataDirectory)
  ) {
    throw new Error('test downloads must stay inside the disposable user-data directory');
  }

  const root = resolve(options.userDataDirectory);
  const destination = resolve(configured);
  const relativeDestination = relative(root, destination);
  if (
    relativeDestination === '' ||
    relativeDestination === '..' ||
    relativeDestination.startsWith(`..${sep}`) ||
    isAbsolute(relativeDestination)
  ) {
    throw new Error('test downloads must stay inside the disposable user-data directory');
  }

  return destination;
}
