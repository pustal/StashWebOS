# Stash for webOS

An unofficial [Stash](https://github.com/stashapp/stash) client for LG webOS TVs, made for the remote and careful with the TV's small storage.

It is inspired by the Android TV clients [StashAppAndroidTV](https://github.com/damontecres/StashAppAndroidTV) and [Sinema](https://github.com/visorcraft/Sinema), and was tested against Stash v0.31. It needs Stash v0.27 or newer, the version that renamed movies to groups.

## Features

- **Home**: Continue watching, Recently added, New releases, Favourite performers, Recent galleries, Groups, Watch again, a shuffled row and Popular tags. The large banner at the top shows whatever card is highlighted. Or, under Settings → Home screen, use the front page you set up in Stash itself (its saved-filter and "recently added/released" rows).
- **Browse**: Scenes, Groups, Markers, Galleries, Images, Performers, Studios and Tags, each with sort options (remembered per section), quick toggles (Unwatched, In progress, Favourites, names-only tags), a **Filter** panel (text search, rating, tags, performers and studios with match all/any and exclusions, organized, resolution, length, date, O-count, number of performers, markers, file path, gender, age, country and scene/image counts, depending on the section, plus **More criteria** for any other number, date, text, yes/no, resolution or tag/performer/studio field the server offers, nested filters such as "performers matching…" or "studios matching…", and **Or match instead…** / **But not…** combinations) and your **saved filters** from Stash, which you can also create, update, rename and delete from the TV.
- **Markers**: browse every scene marker on its own, by date, title, scene, time or duration. Choosing one plays its scene from that point. Tag pages have a Markers tab too. With editing on, markers can be added, changed and deleted (see Editing and Player).
- **Scene page**: Resume / Play from start, details, tech info, performers, studio, groups, galleries, tags and markers. Choosing a marker starts playback at that point.
- **Performer, studio and tag pages** have tabs for their scenes, galleries, images and groups, plus markers on tag pages (empty tabs are hidden). Animated tag images (GIF, WebP, APNG) can stay animated: see Settings → Animated thumbnails. You can mark a performer as a favourite from their page.
- **Galleries**: cover, details, chapters (each opens the viewer at that image), performers, tags, linked scenes and the gallery's images.
- **Groups** (Stash's former "movies"): front and back covers, synopsis, sub-groups and scenes in running order. **Play all** plays them back to back.
- **Image viewer**: full screen, Left/Right through the whole result (further pages load as needed), Play for a slideshow (speed in Settings). OK opens a panel with details and **Zoom in/out, Rotate, Slideshow and Edit**. When zoomed in, the arrows move around the image and Back returns to the whole image. Animated GIFs keep moving and short clips play.
- **Editing** (Edit button on scene, gallery, group, performer, studio and tag pages, and in the image viewer). Every change saves straight away:
  - details: titles and names, studio codes, dates, director, photographer, descriptions (in a larger text box), links (URLs), aliases, and for performers gender, birth/death date, country and height; group length
  - images from a URL (performers, studios, tags, group front/back covers; Stash downloads them), and a scene's cover from any frame of the video
  - ratings (half stars), favourites, O-count and Organized
  - a scene's tags, performers, studio, galleries and groups (search-as-you-type picker; for a group you also set the scene's number in it)
  - a scene's markers: add one at a typed time, change its title, tag, extra tags, time or end time, or delete it
  - links of galleries (studio, performers, tags, scenes), images (studio, performers, tags, galleries) and groups (studio, tags), and the tags of performers and studios
  - hierarchies: a tag's parent tags and sub-tags, a studio's parent studio, and the groups a group is part of and its sub-groups
  - new tags, performers and studios: when a search finds nothing with that exact name, the picker offers to create it (name only)
  - **scraping** scenes, galleries, images, groups and performers with the scrapers and stash-box servers set up in Stash, or from a page URL (performers are searched by name): a review panel lists each field that would change (title, date, details, links, studio, performers, tags, cover…), each can be skipped, and missing studios, performers and tags are created when applied
  - **deleting** any item; scenes, images and galleries can also have their files deleted from disk (you choose, then confirm, with Cancel highlighted)
  - **several items at once**: in a browse screen, **Select** turns on selection mode (OK picks cards, Back ends it); **Actions** then adds or removes a tag, sets the rating, marks them organized or favourite, or deletes them

  Settings → Editing → Off hides every Edit button (and the library tasks below), for a view-only TV.
- **Library tasks** (Settings → Library tasks): Scan for new files, Generate, Auto tag, Identify and Clean, with a live status line and Stop. **Task options** sets what Scan and Generate do and Identify's sources (saved in Stash, shared with its Tasks page). **Scrapers** installs, updates and removes scraper packages; **Stash-box servers** adds and removes servers such as StashDB.
- **Stash server** settings (Settings → Stash server): library folders (add one by browsing the server's folders, choose videos/images, remove), transcode sizes, hardware acceleration and parallel tasks, and plugins (turn on or off, run their tasks, install or update plugin packages).
- **Search** covers scenes, groups, galleries, performers, studios, images and tags together.
- **Player**:
  - Plays the original file whenever the TV can decode it, so Stash doesn't have to transcode. Otherwise it uses an HLS transcode, and if a source fails it moves on to the next one automatically.
  - Seek thumbnails come from Stash's sprite sheets.
  - Markers appear on the timeline and in a list, and Channel Up/Down jump between them. With editing on, the Markers menu also adds a marker at the current time and edits markers, including moving one, or its end, to the current time. Markers with an end time show as a band on the timeline.
  - Subtitles, and a manual Source picker.
  - With editing on, **Set cover** makes the frame on screen the scene's cover.
  - Saves your resume position and play count back to Stash.
- **Magic Remote**: point and click works alongside the D-pad.

## Storage and the image cache

Android TV clients are known to fill a TV's storage with images, mostly tag and performer pictures. There are three reasons: Stash serves *original* images, each image URL has a `?t=<timestamp>` cache buster so every edit creates a new cache entry, and the disk cache keeps everything.

This app handles images differently (see [`src/cache/imageCache.js`](src/cache/imageCache.js)):

1. **No browser disk cache.** Images are fetched with `cache: 'no-store'`, so Chromium never writes them to its HTTP cache.
2. **Shrunk before storing.** Each image is scaled on a canvas to the size it is shown at and re-encoded. A 2 MB poster becomes a ~5–15 KB thumbnail. Animated images (GIF, WebP, APNG) are flattened to a still too by default. Settings → Animated thumbnails → Animated stores them as they are instead (up to 8 MB each), which keeps them moving but fills the cache much faster. Changing the setting refreshes only the animated images, as they are shown.
3. **One entry per image.** Entries are keyed by image path *without* the `t=` buster. A newer version replaces the old one instead of sitting next to it.
4. **A hard size limit.** Settings → Image cache → Storage limit (default 50 MB; 0 = memory only). When the limit is reached, the least recently used thumbnails are deleted. One image can never take more than a tenth of the limit.
5. **Few writes to flash.** The "last used" time is only rewritten every few hours per image.
6. **Large images stay in memory.** The home banner, scene backdrops, seek sprites and full-screen photos in the image viewer are never stored. Viewer photos are scaled to the screen size first, so a 24-megapixel photo doesn't need ~100 MB of RAM to show. Grid thumbnails start from Stash's own 640 px image thumbnails, and Stash's placeholder artwork isn't downloaded at all.
7. **Bounded memory.** The in-memory tier is a capped LRU of object URLs. Images far off screen release their pixels and reload from the cache if you scroll back.

Settings also shows how much space is used, lets you clear the cache, and has a **Tag images → Names only** option that uses no storage for tags at all.

Settings themselves are a few hundred bytes in `localStorage`.

## Requirements

- An LG TV on **webOS 4.0 (2018) or newer**. The bundle is transpiled for Chromium 53.
- A Stash server on your network. If Stash has a password, sign in either with its **API key** (Stash → Settings → Security → API Key) or with the **username and password** (see below).
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
5. On the TV, enter the server address (for example `192.168.1.20:9999`), then either the API key (leave it empty if Stash has no password) or switch to *Username and password*.

To debug on the TV: `npm run tv:inspect` opens Chrome DevTools for the running app.

The `tv:*` scripts read the app id and version from `appinfo.json`. Set `TV_DEVICE` to use a device name other than `tv`.

### Signing in with a username and password

The app always talks to Stash with an API key, or with nothing when Stash has no password. Signing in with a username and password is only a way to get that key:

1. The bundled webOS service (`services/login`, packaged into the same `.ipk`) posts the username and password to Stash's login page.
2. With the resulting session it reads Stash's API key. If Stash has no key yet, it creates one; an existing key is never replaced, so your other clients keep working.
3. The app saves only the key. The password is never stored.

A service is needed because a web app can't keep a Stash login session (Stash's cookie and CORS settings don't allow it), while the service runs in Node.js on the TV and can. If Stash turns out to have no password, nothing is needed and the app connects directly. In a desktop browser there is no webOS service, so use an API key there.

### Rooted TVs

With root access you don't need Developer Mode. Build the package with `npm run package`, then either register the TV with `npx ares-setup-device` using port `22`, user `root` and your SSH key (after that the `tv:*` scripts work), or install over SSH:

```sh
scp out/org.stashwebos.app_0.8.0_all.ipk root@<TV_IP>:/tmp/stash.ipk
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

In the image viewer: Left/Right (or ⏪/⏩) go to the previous/next image, OK or Up/Down opens the panel (details, Zoom in/out, Rotate, Slideshow, Edit), Play starts the slideshow and Pause or OK stops it. When zoomed in, the arrows move around the image. Back closes the panel, then returns a zoomed or rotated image to normal, then closes the viewer. Rotation is only for viewing and isn't saved to Stash.

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
assets/icons/         launcher icons and splash, made from source/stash-logo.jpg by scripts/make-icons.py
scripts/serve.mjs     local static server for development
scripts/tv.mjs        install / launch / inspect on the TV (reads appinfo.json)
services/login/       webOS JS service: username/password → API key (Node.js, runs on the TV)
src/
  main.js             entry: router, sidebar, key handling, startup
  settings.js         settings and their defaults
  session.js          connecting to a server
  polyfills.js        the few APIs missing on webOS 4
  api/client.js       GraphQL client (ApiKey header, timeouts, readable errors)
  api/stash.js        queries, mutations, sort options and filters
  api/login.js        username/password sign-in through the webOS service
  api/savedFilters.js Stash saved filters and front page (schema-driven filter conversion)
  api/tasks.js        library tasks, job queue, task options, packages, stash-box servers, server settings
  cache/imageCache.js bounded thumbnail cache (see above)
  nav/focus.js        spatial navigation for the D-pad and Magic Remote
  player/sources.js   choosing direct play vs transcode and fallbacks
  player/seekPreview.js  sprite-sheet seek thumbnails
  ui/                 router, sidebar, rows, grids, tabbed collections, cards, menus and dialogs,
                      edit panel (editor.js), marker editor, filter panel, scraper, bulk actions,
                      library setup and Stash server settings panels
  screens/            Home, Browse, Scene, Entity, Gallery, Group, Viewer, Search, Settings, Setup, Player
  styles/app.css      all styles
```

No UI framework is used. On TV hardware, direct DOM code keeps the package around 170 KB and scrolling smooth.

## Saved filters

Saved filters appear in two places:

- **Browse screens** get a *Saved filters* button. A saved filter brings its own sort until you choose another one. Its criteria show up in the Filter panel, where you can change them; the button then reads "(changed)". The same menu can save the current view (sort, criteria and toggles) as a new filter, and update, rename or delete the active one. These changes are written to Stash, so the web UI and other clients see them; they are hidden when Settings → Editing is Off.
- **Settings → Home screen → Stash's front page** replaces this app's home rows with the front page configured in Stash (Settings → Interface).

Stash saves filters in its web UI's format, not the format its API accepts. [`src/api/savedFilters.js`](src/api/savedFilters.js) converts them by asking the server for the type of each filter field, so new filter fields in future Stash versions keep working. A field the server doesn't know is skipped rather than failing the whole filter. The Filter panel keeps its criteria in that same format and converts them the same way, so filters saved from the TV open normally in Stash. Criteria the panel can't edit (made in the web UI) are kept, and listed under *Other criteria* where they can be removed.

## Not included yet

- Stash settings that don't suit a TV remote: security (username, password, API key), file naming and paths, the web UI's own interface options, DLNA, logs and backups; use Stash's web UI
- Plugin settings (plugins can be turned on or off and run from the TV)
- Selecting across pages that aren't loaded yet ("select all" covers the cards loaded so far)
