# Stash for webOS

An unofficial [Stash](https://github.com/stashapp/stash) client for LG webOS TVs, made for the remote and careful with the TV's small storage.

It is inspired by the Android TV clients [StashAppAndroidTV](https://github.com/damontecres/StashAppAndroidTV) and [Sinema](https://github.com/visorcraft/Sinema), and was tested against Stash v0.31.

## Features

- **Home**: Continue watching, Recently added, New releases, Favourite performers, Watch again, a shuffled row and Popular tags. The large banner at the top shows whatever card is highlighted.
- **Browse**: Scenes, Performers, Studios and Tags, each with sort options (remembered per section) and filters (Unwatched, In progress, Favourites, names-only tags).
- **Scene page**: Resume / Play from start, details, tech info, performers, studio, tags and markers. Choosing a marker starts playback at that point.
- **Performer, studio and tag pages** list their scenes. You can mark a performer as a favourite from their page.
- **Search** covers scenes, performers, studios and tags together.
- **Player**:
  - Plays the original file whenever the TV can decode it, so Stash doesn't have to transcode. Otherwise it uses an HLS transcode, and if a source fails it moves on to the next one automatically.
  - Seek thumbnails come from Stash's sprite sheets.
  - Markers appear on the timeline and in a list, and Channel Up/Down jump between them.
  - Subtitles, and a manual Source picker.
  - Saves your resume position and play count back to Stash.
- **Magic Remote**: point and click works alongside the D-pad.

## Storage and the image cache

Android TV clients are known to fill a TV's storage with images, mostly tag and performer pictures. There are three reasons: Stash serves *original* images, each image URL has a `?t=<timestamp>` cache buster so every edit creates a new cache entry, and the disk cache keeps everything.

This app handles images differently (see [`src/cache/imageCache.js`](src/cache/imageCache.js)):

1. **No browser disk cache.** Images are fetched with `cache: 'no-store'`, so Chromium never writes them to its HTTP cache.
2. **Shrunk before storing.** Each image is scaled on a canvas to the size it is shown at and re-encoded. A 2 MB poster becomes a ~5–15 KB thumbnail.
3. **One entry per image.** Entries are keyed by image path *without* the `t=` buster. A newer version replaces the old one instead of sitting next to it.
4. **A hard size limit.** Settings → Image cache → Storage limit (default 50 MB; 0 = memory only). When the limit is reached, the least recently used thumbnails are deleted. One image can never take more than a tenth of the limit.
5. **Few writes to flash.** The "last used" time is only rewritten every few hours per image.
6. **Large images stay in memory.** The home banner, scene backdrops and seek sprites are never stored.
7. **Bounded memory.** The in-memory tier is a capped LRU of object URLs. Images far off screen release their pixels and reload from the cache if you scroll back.

Settings also shows how much space is used, lets you clear the cache, and has a **Tag images → Names only** option that uses no storage for tags at all.

Settings themselves are a few hundred bytes in `localStorage`.

## Requirements

- An LG TV on **webOS 4.0 (2018) or newer**. The bundle is transpiled for Chromium 53.
- A Stash server on your network. If Stash has a username and password, you need an **API key** (Stash → Settings → Security → API Key).
- Node.js 20 or newer on your computer (`.nvmrc` pins 22, so with nvm just run `nvm install` in the project folder). `npm install` refuses older versions.

## Install on the TV

1. **Turn on Developer Mode on the TV.** Install the *Developer Mode* app from the LG Content Store, sign in with an LG developer account, and turn on *Dev Mode Status* and *Key Server*. The TV restarts. (Developer Mode expires after 50 hours unless you extend it in the app.)
2. **Install dependencies** (this includes the webOS CLI, `ares-*`):
   ```sh
   npm install
   ```
3. **Register the TV once**, naming it `tv` (the npm scripts use that name):
   ```sh
   npx ares-setup-device        # add: name "tv", IP of the TV, port 9922, user "prisoner"
   npx ares-novacom --device tv --getkey   # enter the passphrase shown in the Developer Mode app
   ```
4. **Build, package, install and launch:**
   ```sh
   npm run tv:deploy
   ```
   Or run the steps one at a time: `npm run package`, `npm run tv:install`, `npm run tv:launch`.
5. On the TV, enter the server address (for example `192.168.1.20:9999`) and the API key if you have one.

To debug on the TV: `npm run tv:inspect` opens Chrome DevTools for the running app.

The `tv:*` scripts read the app id and version from `appinfo.json`. Set `TV_DEVICE` to use a device name other than `tv`.

### Rooted TVs

With root access you don't need Developer Mode. Build the package with `npm run package`, then either register the TV with `npx ares-setup-device` using port `22`, user `root` and your SSH key (after that the `tv:*` scripts work), or install over SSH:

```sh
scp out/org.stashwebos.app_0.1.0_all.ipk root@<TV_IP>:/tmp/stash.ipk
ssh root@<TV_IP> "luna-send -i -f luna://com.webos.appInstallService/dev/install '{\"id\":\"com.ares.defaultName\",\"ipkUrl\":\"/tmp/stash.ipk\",\"subscribe\":true}'"
```

## Develop in a desktop browser

```sh
npm run watch   # rebuilds dist/ on every change
npm run serve   # http://localhost:8080
```

Use the arrow keys, Enter for OK, Escape or Backspace for Back, and Space for play/pause. Chromium on desktop has no H.264/HEVC decoders, so most videos fall back to transcodes there; a VP9/WebM file plays directly.

## Remote control

| Key | Browsing | Player (controls hidden) | Player (controls shown) |
| --- | --- | --- | --- |
| Arrows | Move | Left/Right seek, Up/Down show controls | Move; Left/Right on the timeline seek |
| OK | Open | Play/pause and show controls | Press the button |
| Back | Go back (Home asks before closing) | Leave the player | Hide controls |
| Play / Pause / Stop | | As labelled | As labelled |
| ⏪ / ⏩ | | Seek | Seek |
| Channel up/down | | Next/previous marker | Next/previous marker |

Seek presses add up: tap Right three times and the player makes one jump when you stop.

## Progress tracking

These rules match the other Stash TV clients:

- Nothing is saved if you watch less than 5 seconds.
- The resume point is saved when you pause, every 30 seconds while playing, and when you leave the player.
- Stopping within the last 30 seconds clears the resume point.
- Play count goes up once per viewing, after Stash's *Minimum play percent* (Stash → Settings → Interface).
- If you turn off *Track activity* in Stash, or *Save progress to Stash* here, nothing is written.

## Project layout

```
appinfo.json          webOS app manifest
build.mjs             esbuild bundling (target: Chromium 53)
index.html
assets/icons/         launcher icons and splash (scripts/make-icons.py regenerates them)
scripts/serve.mjs     local static server for development
scripts/tv.mjs        install / launch / inspect on the TV (reads appinfo.json)
src/
  main.js             entry: router, sidebar, key handling, startup
  settings.js         settings and their defaults
  session.js          connecting to a server
  polyfills.js        the few APIs missing on webOS 4
  api/client.js       GraphQL client (ApiKey header, timeouts, readable errors)
  api/stash.js        queries, mutations, sort options and filters
  cache/imageCache.js bounded thumbnail cache (see above)
  nav/focus.js        spatial navigation for the D-pad and Magic Remote
  player/sources.js   choosing direct play vs transcode and fallbacks
  player/seekPreview.js  sprite-sheet seek thumbnails
  ui/                 router, sidebar, rows, grids, cards, menus and dialogs
  screens/            Home, Browse, Scene, Entity, Search, Settings, Setup, Player
  styles/app.css      all styles
```

No UI framework is used. On TV hardware, direct DOM code keeps the bundle around 110 KB packaged and scrolling smooth.

## Not included yet

- Galleries and images
- Groups (movies)
- Editing metadata (other than performer favourites)
- Saved filters from the Stash UI
- Logging in with a username and password. Use an API key instead.
