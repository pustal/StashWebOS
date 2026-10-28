/**
 * PIN lock: a 4-digit PIN asked for when the app starts and when it comes
 * back from the background, so children or guests can't open the library.
 *
 * The PIN is typed with the number keys of the remote or on the on-screen
 * keypad (D-pad or Magic Remote). Back deletes a digit; on the lock screen
 * with nothing typed it closes the app. After five wrong PINs the keypad
 * waits 30 seconds.
 *
 * The PIN is kept in the settings (localStorage). It keeps the app closed to
 * someone at the TV; it is not encryption, and anyone with Developer Mode
 * access to the TV can read it.
 */
import { h, icon } from '../util/dom.js';
import { focus } from '../nav/focus.js';
import { openModal } from './overlay.js';
import { getSettings } from '../settings.js';

export const PIN_LENGTH = 4;
const MAX_TRIES = 5;
const LOCKOUT_S = 30;

let locked = false;
let wrongTries = 0;
let lockedUntil = 0;

/** True when a PIN is set. */
export function hasPin() {
  return !!getSettings().pin;
}

/** True while the lock screen is up. */
export function isLocked() {
  return locked;
}

/**
 * Shows the keypad and resolves with the typed PIN.
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} [opts.message]
 * @param {boolean} [opts.lock]  the lock screen: covers the app, can't be dismissed
 * @param {(pin: string) => boolean} [opts.check]  rejects a PIN (wrong tries count
 *   towards the 30 s wait)
 * @returns {Promise<string|undefined>} undefined when dismissed with Back
 */
export function askPin(opts) {
  return new Promise((resolve) => {
    let typed = '';
    let close = null;
    let waitTimer = null;
    const dots = [];
    for (let i = 0; i < PIN_LENGTH; i++) dots.push(h('span', { class: 'pin-dot' }));
    const dotsEl = h('div', { class: 'pin-dots' }, dots);
    const message = h('p', { class: 'dialog-message pin-message' }, opts.message || '');

    const draw = () => {
      dots.forEach((d, i) => d.classList.toggle('filled', i < typed.length));
    };
    const finish = (value) => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(waitTimer);
      close();
      resolve(value);
    };
    const waiting = () => Date.now() < lockedUntil;
    const showWait = () => {
      const s = Math.ceil((lockedUntil - Date.now()) / 1000);
      if (s <= 0) {
        message.textContent = opts.message || '';
        panel.classList.remove('pin-waiting');
        return;
      }
      panel.classList.add('pin-waiting');
      message.textContent = `Too many wrong PINs. Try again in ${s} s.`;
      waitTimer = setTimeout(showWait, 1000);
    };
    const submit = () => {
      const pin = typed;
      typed = '';
      draw();
      if (opts.check && !opts.check(pin)) {
        wrongTries++;
        panel.classList.remove('pin-wrong');
        void panel.offsetWidth; // restart the shake animation
        panel.classList.add('pin-wrong');
        if (wrongTries >= MAX_TRIES) {
          wrongTries = 0;
          lockedUntil = Date.now() + LOCKOUT_S * 1000;
          showWait();
        } else {
          message.textContent = 'Wrong PIN';
        }
        return;
      }
      wrongTries = 0;
      finish(pin);
    };
    const digit = (d) => {
      if (waiting() || typed.length >= PIN_LENGTH) return;
      typed += d;
      draw();
      if (typed.length === PIN_LENGTH) setTimeout(submit, 150); // let the last dot show
    };
    const erase = () => {
      typed = typed.slice(0, -1);
      draw();
    };

    const key = (label, fn, cls) => h('div', { class: 'pin-key focusable' + (cls ? ` ${cls}` : ''), onSelect: fn }, label);
    const keys = [];
    for (let d = 1; d <= 9; d++) keys.push(key(String(d), () => digit(String(d))));
    keys.push(key(icon('erase'), erase, 'pin-erase'));
    const zero = key('0', () => digit('0'));
    keys.push(zero);
    keys.push(h('span', { class: 'pin-key pin-blank' }));

    const panel = h('div', { class: 'dialog-panel pin-panel' }, [
      opts.lock ? h('img', { class: 'brand-mark pin-brand', src: 'icons/largeIcon.png', alt: '' }) : null,
      h('h2', { class: 'dialog-title' }, opts.title),
      message,
      dotsEl,
      h('div', { class: 'pin-pad nav-group' }, keys),
    ]);

    /** Number keys on the remote (and keyboard / numpad). */
    function onKey(e) {
      const k = e.keyCode;
      if (k >= 48 && k <= 57) digit(String(k - 48));
      else if (k >= 96 && k <= 105) digit(String(k - 96));
      else return;
      e.preventDefault();
      e.stopPropagation();
    }
    document.addEventListener('keydown', onKey);

    close = openModal(panel, {
      persistent: true,
      className: opts.lock ? 'pin-lock' : null,
      // Back: delete a digit; with nothing typed, leave (or close the app).
      onDismiss: () => {
        if (typed) {
          erase();
          return;
        }
        if (opts.lock) window.close();
        else finish(undefined);
      },
    });
    focus(keys[4], { scroll: false }); // the 5 in the middle
    if (waiting()) showWait();
  });
}

/**
 * Shows the lock screen when a PIN is set, and resolves once the right PIN
 * was typed (straight away when there is no PIN or it is already up).
 * @returns {Promise<void>}
 */
export async function unlock() {
  if (!hasPin() || locked) return;
  locked = true;
  await askPin({
    title: 'Enter PIN',
    lock: true,
    check: (pin) => pin === getSettings().pin,
  });
  locked = false;
}
