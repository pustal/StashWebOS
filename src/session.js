/**
 * Connection state: connects to the configured server and keeps the server
 * info (version, play-tracking preferences) other modules need.
 */
import * as api from './api/stash.js';
import { normalizeServerUrl } from './api/client.js';
import { getSettings, updateSettings } from './settings.js';
import { clearImageCache, setImageAuthHeaders } from './cache/imageCache.js';
import { loginForApiKey } from './api/login.js';

let serverInfo = null;

/** Last fetched server info, or null before connecting. */
export function getServerInfo() {
  return serverInfo;
}

/**
 * Tests a server and, if it answers, saves it as the active server.
 * Clears the thumbnail cache when the server changes, so images from
 * another library never linger in storage.
 * @param {string} url
 * @param {string} apiKey
 * @returns {Promise<Object>} server info
 */
export async function connectTo(url, apiKey) {
  const normalized = normalizeServerUrl(url);
  const client = api.connect(normalized, apiKey);
  const info = await api.serverInfo();
  const prev = getSettings().serverUrl;
  if (prev && prev !== normalized) await clearImageCache();
  updateSettings({ serverUrl: normalized, apiKey: (apiKey || '').trim() });
  setImageAuthHeaders(client.authHeaders());
  serverInfo = info;
  return info;
}

/** Reconnects with saved settings (app start). */
export function resume() {
  const s = getSettings();
  if (!s.serverUrl) return Promise.reject(new Error('not configured'));
  return connectTo(s.serverUrl, s.apiKey);
}

/**
 * Connects using a username and password.
 *
 * If the server answers without any credentials (no password set in
 * Stash), that is used as-is. Otherwise the username and password are
 * exchanged for the server's API key (see api/login.js), and from then on
 * the app behaves exactly as if the API key had been typed in. The
 * password itself is never stored.
 * @returns {Promise<{info: Object, usedPassword: boolean}>}
 */
export async function connectWithPassword(url, username, password) {
  const normalized = normalizeServerUrl(url);
  try {
    const info = await connectTo(normalized, '');
    return { info, usedPassword: false };
  } catch (err) {
    if (err.kind !== 'auth') throw err;
  }
  const apiKey = await loginForApiKey(normalized, username, password);
  const info = await connectTo(normalized, apiKey);
  return { info, usedPassword: true };
}
