/**
 * First-run / change-server screen.
 *
 * Two ways to sign in:
 * - API key (or nothing, when Stash has no password): unchanged since 0.1.
 * - Username and password: exchanged once for the server's API key by the
 *   bundled webOS service; only the key is saved (see api/login.js).
 */
import { Screen } from '../ui/router.js';
import { h } from '../util/dom.js';
import { focus } from '../nav/focus.js';
import { getSettings } from '../settings.js';
import { connectTo, connectWithPassword } from '../session.js';

export class SetupScreen extends Screen {
  /**
   * @param {{onConnected: () => void, error?: string}} opts
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.fullscreen = true;
    this.mode = 'key';
    this.el.classList.add('screen-setup');
    const s = getSettings();

    const input = (attrs) => h('input', Object.assign({
      class: 'field-input focusable', autocomplete: 'off', spellcheck: 'false',
    }, attrs));
    this.urlInput = input({
      type: 'url', value: s.serverUrl || '', placeholder: '192.168.1.20:9999', 'data-autofocus': true,
    });
    this.keyInput = input({ type: 'password', value: s.apiKey || '', placeholder: 'Leave empty if Stash has no password' });
    this.userInput = input({ type: 'text', placeholder: 'Stash username' });
    this.passInput = input({ type: 'password', placeholder: 'Stash password' });
    this.inputs = [this.urlInput, this.keyInput, this.userInput, this.passInput];

    this.keyTab = h('div', { class: 'button ghost toggle tab focusable on', onSelect: () => this.setMode('key') }, 'API key');
    this.passTab = h('div', { class: 'button ghost toggle tab focusable', onSelect: () => this.setMode('password') }, 'Username and password');

    this.keyFields = h('div', { class: 'setup-mode' }, [
      h('label', { class: 'field' }, [h('span', { class: 'field-label' }, 'API key'), this.keyInput]),
      h('p', { class: 'setup-help' }, 'Find it in Stash under Settings, Security. Leave it empty if Stash has no password.'),
    ]);
    this.passFields = h('div', { class: 'setup-mode', style: { display: 'none' } }, [
      h('label', { class: 'field' }, [h('span', { class: 'field-label' }, 'Username'), this.userInput]),
      h('label', { class: 'field' }, [h('span', { class: 'field-label' }, 'Password'), this.passInput]),
      h('p', { class: 'setup-help' }, "Used once to fetch Stash's API key; the password isn't saved on the TV."),
    ]);

    this.status = h('p', { class: 'setup-status' + (opts.error ? ' error' : '') }, opts.error || '');
    this.button = h('div', { class: 'button primary focusable', onSelect: () => this.submit() }, 'Connect');

    this.el.appendChild(h('div', { class: 'setup-panel' }, [
      h('div', { class: 'setup-brand' }, [h('span', { class: 'brand-mark' }, 'S'), h('span', { class: 'setup-word' }, 'Stash')]),
      h('h1', { class: 'setup-title' }, 'Connect to your Stash server'),
      h('label', { class: 'field' }, [h('span', { class: 'field-label' }, 'Server address'), this.urlInput]),
      h('div', { class: 'setup-tabs nav-group', 'data-no-memory': true }, [this.keyTab, this.passTab]),
      this.keyFields,
      this.passFields,
      this.button,
      this.status,
    ]));
  }

  /** Switches between the API key and username/password forms. */
  setMode(mode) {
    this.mode = mode;
    this.keyTab.classList.toggle('on', mode === 'key');
    this.passTab.classList.toggle('on', mode === 'password');
    this.keyFields.style.display = mode === 'key' ? '' : 'none';
    this.passFields.style.display = mode === 'password' ? '' : 'none';
  }

  async submit() {
    const url = this.urlInput.value.trim();
    if (!url) {
      this.setStatus('Enter the server address first.', true);
      focus(this.urlInput);
      return;
    }
    if (this.mode === 'password' && !this.userInput.value.trim()) {
      this.setStatus('Enter your Stash username.', true);
      focus(this.userInput);
      return;
    }
    this.setStatus(this.mode === 'password' ? 'Signing in…' : 'Connecting…', false);
    this.button.classList.add('disabled');
    try {
      let info;
      if (this.mode === 'password') {
        const res = await connectWithPassword(url, this.userInput.value.trim(), this.passInput.value);
        info = res.info;
        this.passInput.value = '';
        if (!res.usedPassword) {
          this.setStatus(`Connected to Stash ${info.version}. It has no password, so none was needed.`, false);
        }
      } else {
        info = await connectTo(url, this.keyInput.value);
      }
      if (!this.status.textContent || /…$/.test(this.status.textContent)) {
        this.setStatus(`Connected to Stash ${info.version}.`, false);
      }
      this.opts.onConnected();
    } catch (err) {
      this.setStatus(err.message, true);
      this.button.classList.remove('disabled');
      focus(this.button);
    }
  }

  setStatus(text, isError) {
    this.status.textContent = text;
    this.status.className = 'setup-status' + (isError ? ' error' : '');
  }

  /** The field after `el` in screen order (skipping hidden ones), or the button. */
  nextAfter(el) {
    const order = this.mode === 'key'
      ? [this.urlInput, this.keyInput]
      : [this.urlInput, this.userInput, this.passInput];
    const i = order.indexOf(el);
    return i >= 0 && i < order.length - 1 ? order[i + 1] : this.button;
  }

  /** While typing: OK moves on to the next field; Up/Down leave the field. */
  onKey(e) {
    const active = document.activeElement;
    if (this.inputs.indexOf(active) < 0) return false;
    if (e.keyCode === 13) {
      active.blur();
      focus(this.nextAfter(active));
      return true;
    }
    if (e.keyCode === 38 || e.keyCode === 40) {
      active.blur();
      return false;
    }
    return e.keyCode === 37 || e.keyCode === 39;
  }

  onBack() {
    const active = document.activeElement;
    if (this.inputs.indexOf(active) >= 0) {
      active.blur();
      focus(active);
      return true;
    }
    return false;
  }
}
