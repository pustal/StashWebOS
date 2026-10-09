/**
 * webOS JS service entry point: exposes `login` on the luna bus as
 * luna://org.stashwebos.app.service/login
 *
 * Parameters: { serverUrl, username, password }
 * Response:   { returnValue: true, apiKey } or
 *             { returnValue: false, errorCode, errorText }
 *
 * The web app calls this from the setup screen (src/api/login.js). See
 * stashLogin.js for why this has to run outside the browser.
 */
'use strict';

var Service = require('webos-service');
var pkg = require('./package.json');
var stashLogin = require('./stashLogin');

var service = new Service(pkg.name);

service.register('login', function (message) {
  var p = message.payload || {};
  if (!p.serverUrl || !p.username) {
    message.respond({ returnValue: false, errorCode: 'params', errorText: 'Server address and username are required.' });
    return;
  }
  stashLogin.login(p, function (err, apiKey) {
    if (err) {
      message.respond({ returnValue: false, errorCode: err.code || 'error', errorText: err.message });
    } else {
      message.respond({ returnValue: true, apiKey: apiKey });
    }
  });
});
