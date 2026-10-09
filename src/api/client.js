/**
 * Minimal GraphQL client for the Stash API.
 *
 * Stash serves GraphQL at `<server>/graphql` and allows any CORS origin, so a
 * packaged webOS app (file:// origin) can call it directly. Authentication
 * uses the `ApiKey` header; media URLs returned by Stash already carry the
 * key (or a signed token) in their query string.
 */

/** Request timeout. TVs on Wi-Fi can be slow, but not this slow. */
const TIMEOUT_MS = 20000;

/** Error raised for any failed Stash request. */
export class StashError extends Error {
  /**
   * @param {'network'|'auth'|'timeout'|'graphql'|'http'} kind
   * @param {string} message
   */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

/**
 * Normalises what the user typed into a base URL:
 * adds http:// when missing, removes a trailing slash or "/graphql".
 * @param {string} input
 * @returns {string}
 */
export function normalizeServerUrl(input) {
  let url = String(input || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  url = url.replace(/\/+$/, '').replace(/\/graphql$/i, '');
  return url;
}

export class StashClient {
  /**
   * @param {string} serverUrl  normalised base URL
   * @param {string} [apiKey]
   */
  constructor(serverUrl, apiKey) {
    this.serverUrl = serverUrl;
    this.apiKey = (apiKey || '').trim();
  }

  /** Headers to send with any request to the Stash server. */
  authHeaders() {
    return this.apiKey ? { ApiKey: this.apiKey } : {};
  }

  /**
   * Runs a GraphQL query or mutation.
   * @param {string} query
   * @param {Object} [variables]
   * @returns {Promise<Object>} the `data` object
   */
  async query(query, variables) {
    const body = JSON.stringify({ query, variables: variables || {} });
    const headers = Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, this.authHeaders());

    // AbortController only exists from Chromium 66; older TVs just race a timer.
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (controller) controller.abort();
        reject(new StashError('timeout', 'The server took too long to answer.'));
      }, TIMEOUT_MS);
    });

    let res;
    try {
      res = await Promise.race([
        fetch(this.serverUrl + '/graphql', {
          method: 'POST',
          headers,
          body,
          credentials: 'omit',
          cache: 'no-store',
          signal: controller ? controller.signal : undefined,
        }),
        timeout,
      ]);
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof StashError) throw e;
      throw new StashError('network', `Can't reach ${this.serverUrl}. Check the address and that Stash is running.`);
    }
    clearTimeout(timer);

    if (res.status === 401 || res.status === 403) {
      throw new StashError('auth', this.apiKey
        ? 'Stash rejected the API key. Copy it again from Stash → Settings → Security.'
        : 'This Stash server is password protected. Enter its API key.');
    }
    // Stash redirects unauthenticated browser requests to /login.
    if (res.redirected && /\/login/.test(res.url)) {
      throw new StashError('auth', 'This Stash server is password protected. Enter its API key.');
    }
    if (!res.ok) {
      throw new StashError('http', `Stash answered with HTTP ${res.status}.`);
    }

    let json;
    try {
      json = await res.json();
    } catch (e) {
      throw new StashError('http', 'The server did not answer like a Stash server. Check the address and port.');
    }
    if (json.errors && json.errors.length) {
      const msg = json.errors.map((er) => er.message).join('; ');
      if (/not authorized|unauthorized/i.test(msg)) throw new StashError('auth', 'This Stash server is password protected. Enter its API key.');
      throw new StashError('graphql', msg);
    }
    return json.data;
  }
}
