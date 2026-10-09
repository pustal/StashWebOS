/**
 * Username/password sign-in.
 *
 * The app itself always talks to Stash with an API key (or with nothing,
 * when Stash has no password). Signing in with a username and password is
 * only a way to *obtain* that key: the bundled webOS service
 * (services/login) logs in, reads the server's API key (creating one if the
 * server has none) and hands it back. The password is never stored.
 *
 * In a desktop browser there is no webOS service; a browser sign-in is
 * attempted instead, which only works when the browser allows Stash's
 * session cookie (normally it does not; see services/login/stashLogin.js).
 */

const SERVICE_URI = 'luna://org.stashwebos.app.service/login';

/** Error with a code: 'credentials', 'network', 'unsupported', 'service', ... */
export class LoginError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** True when running on webOS (the luna bus is available). */
export function hasLunaBus() {
  return typeof window !== 'undefined' && typeof window.PalmServiceBridge !== 'undefined';
}

/**
 * Calls a luna service method once.
 * webOSTV.js wraps exactly this; using PalmServiceBridge directly avoids
 * shipping the library for one call.
 * @returns {Promise<Object>} the service's response
 */
function lunaCall(uri, params) {
  return new Promise((resolve, reject) => {
    const bridge = new window.PalmServiceBridge();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new LoginError('service', 'The sign-in helper did not answer.'));
    }, 30000);
    bridge.onservicecallback = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let res;
      try {
        res = JSON.parse(msg);
      } catch (e) {
        reject(new LoginError('service', 'The sign-in helper gave an unreadable answer.'));
        return;
      }
      resolve(res);
    };
    // Keep a reference until the callback fires, or the bridge may be collected.
    lunaCall.pending = bridge;
    bridge.call(uri, JSON.stringify(params));
  });
}

/** Sign-in through the bundled webOS service (on the TV). */
async function viaService(serverUrl, username, password) {
  const res = await lunaCall(SERVICE_URI, { serverUrl, username, password });
  if (res.returnValue && res.apiKey) return res.apiKey;
  const code = res.errorCode || 'service';
  // errorCode -1 / errorText "Unknown method" etc. come from the bus itself.
  if (typeof code === 'number' || /service|not found|denied/i.test(res.errorText || '')) {
    throw new LoginError('service', `The sign-in helper couldn't run (${res.errorText || code}). Use an API key instead.`);
  }
  throw new LoginError(code, res.errorText || 'Sign-in failed.');
}

/** Sign-in from the browser (development only; usually blocked by CORS). */
async function viaBrowser(serverUrl, username, password) {
  const form = new URLSearchParams();
  form.set('username', username);
  form.set('password', password);
  form.set('returnURL', '/');
  let res;
  try {
    res = await fetch(`${serverUrl}/login`, { method: 'POST', body: form, credentials: 'include' });
  } catch (e) {
    throw new LoginError('unsupported', 'Signing in with a password only works on the TV. Here, use an API key.');
  }
  if (res.status === 401) throw new LoginError('credentials', 'Wrong username or password.');
  try {
    const gql = await fetch(`${serverUrl}/graphql`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ configuration { general { apiKey } } }' }),
    });
    const json = await gql.json();
    const key = json.data && json.data.configuration.general.apiKey;
    if (key) return key;
  } catch (e) { /* fall through */ }
  throw new LoginError('unsupported', 'Signing in with a password only works on the TV. Here, use an API key.');
}

/**
 * Signs in and returns the server's API key.
 * @param {string} serverUrl  normalised base URL
 * @param {string} username
 * @param {string} password
 * @returns {Promise<string>}
 */
export function loginForApiKey(serverUrl, username, password) {
  return hasLunaBus() ? viaService(serverUrl, username, password) : viaBrowser(serverUrl, username, password);
}
