/**
 * Showing a web link on a TV, where it can't simply be clicked: a QR code
 * to scan with a phone, the address in text, and (on webOS) a button that
 * opens it in the TV's own web browser.
 */
import qrcode from 'qrcode-generator';
import { h } from '../util/dom.js';
import { focus } from '../nav/focus.js';
import { openModal, toast } from './overlay.js';

/** True on a webOS TV (the luna service bus is there). */
function canLaunchBrowser() {
  return typeof window !== 'undefined' && typeof window.PalmServiceBridge !== 'undefined';
}

/**
 * Opens a web page in the TV's browser (webOS application manager).
 * @param {string} url
 * @returns {Promise<void>}
 */
function openInTvBrowser(url) {
  return new Promise((resolve, reject) => {
    const bridge = new window.PalmServiceBridge();
    bridge.onservicecallback = (msg) => {
      let res = {};
      try {
        res = JSON.parse(msg);
      } catch (e) { /* treat as failure below */ }
      if (res.returnValue) resolve();
      else reject(new Error(res.errorText || 'the browser could not be opened'));
    };
    bridge.call('luna://com.webos.applicationManager/launch',
      JSON.stringify({ id: 'com.webos.app.browser', params: { target: url } }));
  });
}

/**
 * A QR code for a text, as an inline SVG element (dark on light, with a
 * quiet zone, so phones read it reliably from a TV screen).
 */
function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const box = h('div', { class: 'qr-code' });
  box.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 4, scalable: true });
  return box;
}

/**
 * Shows a link.
 * @param {Object} opts
 * @param {string} opts.title  e.g. "Stash for webOS on GitHub"
 * @param {string} opts.url
 * @param {string} [opts.text]  a line under the title
 */
export function showLink(opts) {
  let close = null;
  const buttons = [];
  if (canLaunchBrowser()) {
    buttons.push(h('div', {
      class: 'button primary focusable',
      onSelect: () => openInTvBrowser(opts.url).then(() => close(), (err) => toast(`Couldn't open the browser: ${err.message}`, 'error')),
    }, 'Open in the TV’s browser'));
  }
  const closeButton = h('div', { class: 'button ghost focusable', onSelect: () => close() }, 'Close');
  buttons.push(closeButton);
  const panel = h('div', { class: 'dialog-panel link-dialog' }, [
    h('h2', { class: 'dialog-title' }, opts.title),
    opts.text ? h('p', { class: 'dialog-message' }, opts.text) : null,
    h('div', { class: 'link-body' }, [
      qrSvg(opts.url),
      h('div', { class: 'link-side' }, [
        h('p', { class: 'link-hint' }, 'Scan with your phone, or go to:'),
        h('p', { class: 'link-url' }, opts.url.replace(/^https?:\/\//, '')),
      ]),
    ]),
    h('div', { class: 'dialog-actions' }, buttons),
  ]);
  close = openModal(panel);
  focus(buttons[0]);
}
