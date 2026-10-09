/**
 * Stash for webOS: entry point.
 *
 * Wires the router, sidebar, focus engine and image cache together, routes
 * remote-control keys, and decides between the setup screen and Home.
 */
import './polyfills.js';
import { h } from './util/dom.js';
import { KEY, directionOf, isBack } from './util/keys.js';
import {
  focusFirst, getFocused, initFocus, move, select,
} from './nav/focus.js';
import { Router } from './ui/router.js';
import { Sidebar } from './ui/sidebar.js';
import { registerNavigation, openSection } from './ui/navigate.js';
import { closeTopModal, confirmDialog, hasModal } from './ui/overlay.js';
import { initImageCache } from './cache/imageCache.js';
import { getSettings } from './settings.js';
import { resume } from './session.js';

import { HomeScreen } from './screens/home.js';
import { BrowseScreen } from './screens/browse.js';
import { SceneScreen } from './screens/scene.js';
import { EntityScreen } from './screens/entity.js';
import { SearchScreen } from './screens/search.js';
import { SettingsScreen } from './screens/settings.js';
import { SetupScreen } from './screens/setup.js';
import { PlayerScreen } from './screens/player.js';
import { GalleryScreen } from './screens/gallery.js';
import { GroupScreen } from './screens/group.js';
import { ViewerScreen } from './screens/viewer.js';

const appRoot = document.getElementById('app');
const sidebar = new Sidebar();
const content = h('main', { class: 'content nav-zone' });
appRoot.appendChild(sidebar.el);
appRoot.appendChild(content);
initFocus(appRoot);

const router = new Router(content, {
  onChange(screen) {
    sidebar.setVisible(!screen.fullscreen);
    if (screen.section) sidebar.setActive(screen.section);
  },
});

/** Shows the connection screen (first run, errors, "Change server"). */
function showSetup(error) {
  router.reset(new SetupScreen({
    error,
    onConnected: () => openSection('home'),
  }));
}

registerNavigation(router, {
  scene: (item) => new SceneScreen(item),
  performer: (item) => new EntityScreen('performer', item),
  studio: (item) => new EntityScreen('studio', item),
  tag: (item) => new EntityScreen('tag', item),
  player: (item, extra) => new PlayerScreen(item, extra),
  gallery: (item) => new GalleryScreen(item),
  group: (item) => new GroupScreen(item),
  image: (item, extra) => new ViewerScreen(item, extra),
  // A marker plays its scene from the marker's time.
  marker: (m) => new PlayerScreen(m.scene, { start: m.seconds }),
  'section:home': () => new HomeScreen(),
  'section:search': () => new SearchScreen(),
  'section:scenes': () => new BrowseScreen('scenes'),
  'section:groups': () => new BrowseScreen('groups'),
  'section:markers': () => new BrowseScreen('markers'),
  'section:galleries': () => new BrowseScreen('galleries'),
  'section:images': () => new BrowseScreen('images'),
  'section:performers': () => new BrowseScreen('performers'),
  'section:studios': () => new BrowseScreen('studios'),
  'section:tags': () => new BrowseScreen('tags'),
  'section:settings': () => new SettingsScreen({ onDisconnect: () => showSetup() }),
});

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

let exitPromptOpen = false;

/** Back at the root of Home asks before closing the app. */
async function askExit() {
  if (exitPromptOpen) return;
  exitPromptOpen = true;
  const ok = await confirmDialog({
    title: 'Close Stash?', confirm: 'Close', cancel: 'Stay', safe: true,
  });
  exitPromptOpen = false;
  if (ok) {
    // webOS closes the app; in a desktop browser this is a no-op.
    window.close();
  }
}

function handleBack() {
  if (closeTopModal()) return;
  const top = router.top;
  if (top && top.onBack()) return;
  if (router.back()) return;
  // At a section root: other sections go back to Home, Home asks to exit.
  if (top && top.section && top.section !== 'home') {
    openSection('home');
    return;
  }
  askExit();
}

document.addEventListener('keydown', (e) => {
  const typing = document.activeElement && document.activeElement.tagName === 'INPUT';
  const top = router.top;

  // Screens get first pick (player keys, text-field handling) unless a modal is open.
  if (!hasModal() && top && top.onKey(e)) {
    if (!typing) e.preventDefault();
    return;
  }
  if (isBack(e)) {
    e.preventDefault();
    handleBack();
    return;
  }
  if (typing) return; // let the field handle everything else

  const dir = directionOf(e);
  if (dir) {
    e.preventDefault();
    if (!getFocused() || !document.documentElement.contains(getFocused())) focusFirst();
    else move(dir);
    return;
  }
  if (e.keyCode === KEY.ENTER) {
    e.preventDefault();
    select();
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function start() {
  const s = getSettings();
  await initImageCache({ budgetBytes: s.cacheBudgetMB * 1024 * 1024, keepAnimated: s.animatedThumbs });
  if (!s.serverUrl) {
    showSetup();
    return;
  }
  try {
    await resume();
    openSection('home');
  } catch (err) {
    showSetup(err.message === 'not configured' ? '' : err.message);
  }
}

start();
