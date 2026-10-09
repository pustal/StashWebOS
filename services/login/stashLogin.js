/**
 * Signs in to a Stash server with a username and password and returns its
 * API key. Runs in the webOS JS service (Node.js), not in the web app.
 *
 * Why a service? Stash's login creates a session cookie (SameSite=Lax) and
 * Stash answers cross-origin requests with "Access-Control-Allow-Origin: *",
 * which browsers never combine with cookies. A web app on the TV therefore
 * cannot keep a Stash session. Node has no such limits, so this service:
 *
 *   1. POSTs the username and password to <server>/login,
 *   2. uses the session cookie it gets back to read the server's API key,
 *   3. creates an API key only if the server doesn't have one yet (an
 *      existing key is never replaced, so other clients keep working),
 *   4. returns the key. The password is not stored anywhere.
 *
 * Written for old Node versions (webOS 4 ships Node 8): callbacks, no fetch.
 */
'use strict';

var http = require('http');
var https = require('https');
var urlLib = require('url');
var querystring = require('querystring');

/** Request timeout in ms. */
var TIMEOUT = 15000;

/**
 * Makes an HTTP(S) request and collects the response.
 * @param {string} method
 * @param {string} url
 * @param {Object} headers
 * @param {string|null} body
 * @param {function(Error|null, {status: number, headers: Object, body: string}=)} cb
 */
function request(method, url, headers, body, cb) {
  var u = urlLib.parse(url);
  var lib = u.protocol === 'https:' ? https : http;
  var opts = {
    method: method,
    hostname: u.hostname,
    port: u.port,
    path: u.path,
    headers: headers,
    // Home servers often use self-signed certificates.
    rejectUnauthorized: false,
  };
  var done = false;
  var req = lib.request(opts, function (res) {
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () {
      if (done) return;
      done = true;
      cb(null, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
    });
  });
  req.on('error', function (err) {
    if (done) return;
    done = true;
    cb(err);
  });
  req.setTimeout(TIMEOUT, function () {
    req.abort();
    if (done) return;
    done = true;
    cb(new Error('timeout'));
  });
  if (body) req.write(body);
  req.end();
}

/**
 * Extracts "name=value" pairs from Set-Cookie headers into a Cookie header.
 * @param {string|string[]|undefined} setCookie
 */
function cookieHeader(setCookie) {
  if (!setCookie) return '';
  var list = Array.isArray(setCookie) ? setCookie : [setCookie];
  return list.map(function (c) { return c.split(';')[0]; }).join('; ');
}

/** Runs a GraphQL query with the session cookie. */
function graphql(base, cookie, query, cb) {
  var body = JSON.stringify({ query: query });
  request('POST', base + '/graphql', {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    Cookie: cookie,
  }, body, function (err, res) {
    if (err) return cb(err);
    if (res.status === 401 || res.status === 403) return cb(codeError('auth', 'Stash did not accept the sign-in.'));
    var json;
    try {
      json = JSON.parse(res.body);
    } catch (e) {
      return cb(codeError('http', 'Unexpected answer from Stash (HTTP ' + res.status + ').'));
    }
    if (json.errors && json.errors.length) return cb(codeError('graphql', json.errors[0].message));
    cb(null, json.data);
  });
}

/** Error with a machine-readable code. */
function codeError(code, message) {
  var e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Signs in and returns the API key.
 * @param {{serverUrl: string, username: string, password: string}} p
 * @param {function(Error|null, string=)} cb  called with the API key
 */
function login(p, cb) {
  var base = String(p.serverUrl || '').replace(/\/+$/, '');
  var form = querystring.stringify({ username: p.username || '', password: p.password || '', returnURL: '/' });
  request('POST', base + '/login', {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(form),
  }, form, function (err, res) {
    if (err) return cb(codeError('network', "Can't reach " + base + '.'));
    if (res.status === 401) return cb(codeError('credentials', 'Wrong username or password.'));
    // Newer Stash answers 200; older versions redirect (302) after login.
    if (res.status !== 200 && res.status !== 302 && res.status !== 303) {
      return cb(codeError('http', 'Stash answered the sign-in with HTTP ' + res.status + '.'));
    }
    var cookie = cookieHeader(res.headers['set-cookie']);
    if (!cookie) return cb(codeError('credentials', 'Wrong username or password.'));

    graphql(base, cookie, '{ configuration { general { apiKey } } }', function (err2, data) {
      if (err2) return cb(err2);
      var key = data && data.configuration && data.configuration.general && data.configuration.general.apiKey;
      if (key) return cb(null, key);
      // No key yet: create one (clear: false generates a new key).
      graphql(base, cookie, 'mutation { generateAPIKey(input: { clear: false }) }', function (err3, data3) {
        if (err3) return cb(err3);
        if (!data3 || !data3.generateAPIKey) return cb(codeError('graphql', 'Stash did not create an API key.'));
        cb(null, data3.generateAPIKey);
      });
    });
  });
}

module.exports = { login: login, cookieHeader: cookieHeader };
