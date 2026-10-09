/**
 * Modal choice menus, confirmation dialogs and toasts.
 */
import { h, icon } from '../util/dom.js';
import { pushLayer } from '../nav/focus.js';

/** Currently open modal close functions (top = last), for the Back key. */
const openModals = [];

/**
 * Closes the topmost modal.
 * @returns {boolean} true when a modal was open
 */
export function closeTopModal() {
  const close = openModals[openModals.length - 1];
  if (!close) return false;
  close();
  return true;
}

/** True while a modal is open. */
export function hasModal() {
  return openModals.length > 0;
}

/**
 * Opens a modal panel. The panel is focus-trapped until closed.
 * @param {HTMLElement} panel
 * @param {{side?: boolean, onDismiss?: () => void}} [opts]
 *   side=true slides in from the right; onDismiss runs when Back closes it
 * @returns {() => void} close function (does not call onDismiss)
 */
function openModal(panel, opts) {
  const o = opts || {};
  const scrim = h('div', { class: 'modal-scrim no-scroll' + (o.side ? ' side' : '') }, panel);
  document.body.appendChild(scrim);
  let closed = false;
  let popLayer = null;
  const close = () => {
    if (closed) return;
    closed = true;
    const i = openModals.indexOf(dismiss);
    if (i >= 0) openModals.splice(i, 1);
    if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
    if (popLayer) popLayer();
  };
  const dismiss = () => {
    close();
    if (o.onDismiss) o.onDismiss();
  };
  openModals.push(dismiss);
  popLayer = pushLayer(scrim);
  return close;
}

/**
 * Shows a list of options and resolves with the chosen value.
 * @param {Object} opts
 * @param {string} opts.title
 * @param {Array<{label: string, value: *, hint?: string}>} opts.options
 * @param {*} [opts.selected] value shown with a check mark (and focused)
 * @returns {Promise<*>} chosen value, or undefined when dismissed
 */
export function chooseOption(opts) {
  return new Promise((resolve) => {
    let close = null;
    const items = opts.options.map((o) => {
      const isSel = o.value === opts.selected;
      return h('div', {
        class: 'menu-item focusable' + (isSel ? ' selected' : ''),
        'data-autofocus': isSel || null,
        onSelect: () => {
          close();
          resolve(o.value);
        },
      }, [
        h('span', { class: 'menu-label' }, o.label),
        o.hint ? h('span', { class: 'menu-hint' }, o.hint) : null,
        isSel ? icon('check', 'menu-check') : null,
      ]);
    });
    const panel = h('div', { class: 'menu-panel' }, [
      h('h2', { class: 'menu-title' }, opts.title),
      h('div', { class: 'menu-list' }, items),
    ]);
    close = openModal(panel, { side: true, onDismiss: () => resolve(undefined) });
  });
}

/**
 * Yes/no confirmation.
 * @param {{title: string, message?: string, confirm: string, cancel?: string, safe?: boolean}} opts
 *   safe=true highlights Cancel first, for actions that are annoying to trigger by accident
 * @returns {Promise<boolean>}
 */
export function confirmDialog(opts) {
  return new Promise((resolve) => {
    let close = null;
    const done = (v) => {
      close();
      resolve(v);
    };
    const panel = h('div', { class: 'dialog-panel' }, [
      h('h2', { class: 'dialog-title' }, opts.title),
      opts.message ? h('p', { class: 'dialog-message' }, opts.message) : null,
      h('div', { class: 'dialog-actions' }, [
        h('div', { class: 'button focusable', 'data-autofocus': opts.safe ? null : true, onSelect: () => done(true) }, opts.confirm),
        h('div', { class: 'button ghost focusable', 'data-autofocus': opts.safe ? true : null, onSelect: () => done(false) }, opts.cancel || 'Cancel'),
      ]),
    ]);
    close = openModal(panel, { onDismiss: () => resolve(false) });
  });
}

let toastTimer = null;

/**
 * Shows a short message at the bottom of the screen.
 * @param {string} message
 * @param {'info'|'error'} [kind]
 */
export function toast(message, kind) {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', class: 'toast' });
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = 'toast visible' + (kind === 'error' ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = 'toast' + (kind === 'error' ? ' error' : '');
  }, kind === 'error' ? 5000 : 2800);
}
