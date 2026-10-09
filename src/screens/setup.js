/**
 * First-run / change-server screen: server address and optional API key.
 */
import { Screen } from '../ui/router.js';
import { h } from '../util/dom.js';
import { focus } from '../nav/focus.js';
import { getSettings } from '../settings.js';
import { connectTo } from '../session.js';

export class SetupScreen extends Screen {
  /**
   * @param {{onConnected: () => void, error?: string}} opts
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.fullscreen = true;
    this.el.classList.add('screen-setup');
    const s = getSettings();

    this.urlInput = h('input', {
      class: 'field-input focusable',
      type: 'url',
      value: s.serverUrl || '',
      placeholder: '192.168.1.20:9999',
      autocomplete: 'off',
      spellcheck: 'false',
      'data-autofocus': true,
    });
    this.keyInput = h('input', {
      class: 'field-input focusable',
      type: 'password',
      value: s.apiKey || '',
      placeholder: 'Leave empty if Stash has no password',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    this.status = h('p', { class: 'setup-status' + (opts.error ? ' error' : '') }, opts.error || '');
    this.button = h('div', { class: 'button primary focusable', onSelect: () => this.submit() }, 'Connect');

    this.el.appendChild(h('div', { class: 'setup-panel' }, [
      h('div', { class: 'setup-brand' }, [h('span', { class: 'brand-mark' }, 'S'), h('span', { class: 'setup-word' }, 'Stash')]),
      h('h1', { class: 'setup-title' }, 'Connect to your Stash server'),
      h('label', { class: 'field' }, [h('span', { class: 'field-label' }, 'Server address'), this.urlInput]),
      h('label', { class: 'field' }, [h('span', { class: 'field-label' }, 'API key'), this.keyInput]),
      h('p', { class: 'setup-help' }, 'Find the API key in Stash under Settings, Security. The address usually ends in :9999.'),
      this.button,
      this.status,
    ]));
  }

  async submit() {
    const url = this.urlInput.value.trim();
    if (!url) {
      this.setStatus('Enter the server address first.', true);
      focus(this.urlInput);
      return;
    }
    this.setStatus('Connecting…', false);
    this.button.classList.add('disabled');
    try {
      const info = await connectTo(url, this.keyInput.value);
      this.setStatus(`Connected to Stash ${info.version}.`, false);
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

  /** While typing: OK moves on to the next field; Up/Down leave the field. */
  onKey(e) {
    const active = document.activeElement;
    if (active !== this.urlInput && active !== this.keyInput) return false;
    if (e.keyCode === 13) {
      active.blur();
      focus(active === this.urlInput ? this.keyInput : this.button);
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
    if (active === this.urlInput || active === this.keyInput) {
      active.blur();
      focus(active);
      return true;
    }
    return false;
  }
}
