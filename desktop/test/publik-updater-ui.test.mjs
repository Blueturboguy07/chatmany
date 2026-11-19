// The parts of publik-updater.cjs that run inside Electron, as chatmany starts them (src/main/main.ts:
// startUpdates({ slug: "chatmany", appName: "chatmany", menu: false }), then the app's own menu holds
// updates.menuItem()): the check at launch, the check every 24 hours, "Check for Updates…" and the restart
// question. electron and electron-updater's autoUpdater are fakes here (Module._load), and vitest's fake
// timers stand in for setInterval and setTimeout. The live proof (.github/workflows/live-update-proof.yml)
// clicks the same menu item through the UI of the installed app; this test also covers the Windows Help
// menu item, which a runner may not be able to click. Adapted from the publik updater template
// (Blueturboguy07/surfcam, test/publik-updater-ui.test.mjs).
import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const DAY = 24 * 60 * 60 * 1000;

let current = null; // the fakes of the running test
const realLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (current && request === 'electron') return current.electron;
  if (request === 'electron-updater') {
    const real = realLoad.call(this, request, parent, isMain);
    return { CancellationToken: real.CancellationToken, get autoUpdater() { return current.updater; } };
  }
  return realLoad.call(this, request, parent, isMain);
};
const { startUpdates } = require('../publik-updater.cjs');

/** A fresh fake Electron app (packaged, version `version`) and autoUpdater. `answer` is the button index a dialog returns. */
function fakes({ version = '0.1.2', answer = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatmany-updater-ui-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'chatmany-desktop', version }));
  fs.writeFileSync(path.join(dir, 'app-update.yml'), 'provider: generic\n');
  const f = { dir, dialogs: [], menu: null, installs: [] };
  const updater = new EventEmitter();
  updater.checks = 0;
  updater.checkForUpdates = () => { updater.checks++; updater.emit('checking-for-update'); return Promise.resolve(null); };
  updater.setFeedURL = (o) => { updater.feed = o; };
  updater.quitAndInstall = (...a) => { f.installs.push(a); };
  f.updater = updater;
  f.electron = {
    app: { getName: () => 'chatmany', getVersion: () => version, isPackaged: true, getAppPath: () => dir, getPath: () => dir },
    dialog: { showMessageBox: async (...a) => { const o = a[a.length - 1]; f.dialogs.push(o); return { response: o.buttons.length > 1 ? answer : 0 }; } },
    BrowserWindow: { getFocusedWindow: () => null },
    Menu: { buildFromTemplate: (t) => t, setApplicationMenu: (m) => { f.menu = m; } },
    autoUpdater: new EventEmitter(), // Squirrel.Mac's own updater (macOS)
  };
  return f;
}

let saved;
beforeEach(() => {
  saved = {
    platform: Object.getOwnPropertyDescriptor(process, 'platform'),
    resourcesPath: process.resourcesPath,
    env: { PUBLIK_UPDATES: process.env.PUBLIK_UPDATES, PUBLIK_UPDATER_TEST: process.env.PUBLIK_UPDATER_TEST },
  };
});
afterEach(() => {
  vi.useRealTimers();
  if (current) fs.rmSync(current.dir, { recursive: true, force: true });
  current = null;
  Object.defineProperty(process, 'platform', saved.platform);
  process.resourcesPath = saved.resourcesPath;
  for (const [k, v] of Object.entries(saved.env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

/** Installs the fakes as if on `platform`, with PUBLIK_UPDATES as given (CI sets it to 0), and fake timers on. */
function on(platform, f, { updates } = {}) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  process.resourcesPath = f.dir;
  delete process.env.PUBLIK_UPDATER_TEST;
  if (updates === undefined) delete process.env.PUBLIK_UPDATES; else process.env.PUBLIK_UPDATES = updates;
  current = f;
  // setImmediate stays real: "Restart Now" installs on the next turn (setImmediate), which settle() awaits.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
}
const settle = () => new Promise((r) => setImmediate(r));
/** As src/main/main.ts starts the updater: chatmany builds its own menu with updates.menuItem(). */
const start = () => startUpdates({ slug: 'chatmany', appName: 'chatmany', menu: false });
const notFound = () => Object.assign(new Error('Cannot get latest.yml from the update feed: Cannot download "https://publikhq.com/api/updates/chatmany/latest.yml?noCache=1", status 404: Not Found'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' });

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: the app checks at launch, then every 24 hours, silently`, () => {
    const f = fakes();
    on(platform, f);
    const u = start();
    assert.equal(u.testHook, false);
    assert.equal(f.updater.feed.url, 'https://publikhq.com/api/updates/chatmany/');
    assert.equal(f.updater.feed.slug, 'chatmany');
    assert.equal(f.menu, null, 'menu: false: publik-updater.cjs leaves the menu to the app');
    assert.equal(f.updater.checks, 1, 'one check at launch');
    f.updater.emit('update-not-available', { version: '0.1.2' });
    vi.advanceTimersByTime(DAY - 1);
    assert.equal(f.updater.checks, 1, 'nothing before 24 hours');
    vi.advanceTimersByTime(1);
    assert.equal(f.updater.checks, 2, 'the 24-hour check fired');
    f.updater.emit('error', notFound()); // the feed answers 404: no update
    vi.advanceTimersByTime(DAY);
    assert.equal(f.updater.checks, 3, 'and again 24 hours later');
    f.updater.emit('error', Object.assign(new Error('offline'), { code: 'ERR_PUBLIK_FEED_FETCH' }));
    vi.advanceTimersByTime(DAY);
    assert.equal(f.updater.checks, 4, 'a failed check does not stop the next one');
    assert.equal(f.dialogs.length, 0, 'background checks show nothing (no error, no 404 notice)');
  });

  test(`${platform}: PUBLIK_UPDATES=0 stops the automatic checks; the menu item still works`, () => {
    const f = fakes();
    on(platform, f, { updates: '0' });
    const u = start();
    vi.advanceTimersByTime(3 * DAY);
    assert.equal(f.updater.checks, 0);
    u.menuItem().click();
    assert.equal(f.updater.checks, 1);
  });

  test(`${platform}: "Check for Updates…" answers "You’re up to date." with the running version`, () => {
    const f = fakes({ version: '0.1.3' });
    on(platform, f);
    const u = start();
    f.updater.emit('update-not-available', { version: '0.1.3' }); // the launch check: silent
    assert.equal(f.dialogs.length, 0);
    const item = u.menuItem();
    assert.equal(item.label, 'Check for Updates…');
    item.click();
    assert.equal(f.updater.checks, 2);
    f.updater.emit('update-not-available', { version: '0.1.3' });
    assert.equal(f.dialogs.length, 1);
    assert.equal(f.dialogs[0].message, 'You’re up to date.');
    assert.equal(f.dialogs[0].detail, 'chatmany 0.1.3 is the newest version.');
  });

  test(`${platform}: "Check for Updates…" while the feed answers 404 says "No update is available." (no error)`, () => {
    const f = fakes();
    on(platform, f);
    const u = start();
    f.updater.emit('error', notFound()); // the launch check: silent
    assert.equal(f.dialogs.length, 0);
    u.menuItem().click();
    assert.equal(f.updater.checks, 2);
    f.updater.emit('error', notFound());
    assert.equal(f.dialogs.length, 1);
    assert.equal(f.dialogs[0].type, 'info');
    assert.equal(f.dialogs[0].message, 'No update is available.');
    assert.equal(f.dialogs[0].detail, 'chatmany 0.1.2 is the version you have.');
  });

  test(`${platform}: a refused feed on a manual check says "Could not update."`, () => {
    const f = fakes();
    on(platform, f);
    const u = start();
    u.menuItem().click();
    f.updater.emit('error', Object.assign(new Error('latest.yml is not signed by the publik update key: bad signature'), { code: 'ERR_PUBLIK_FEED_SIGNATURE' }));
    assert.equal(f.dialogs.length, 1);
    assert.equal(f.dialogs[0].type, 'warning');
    assert.equal(f.dialogs[0].message, 'Could not update.');
  });

  for (const [answer, label] of [[0, 'Restart Now'], [1, 'Later']]) {
    test(`${platform}: a downloaded update asks "Restart now?"; ${label} ${answer === 0 ? 'installs now' : 'leaves it for the quit'}`, async () => {
      const f = fakes({ answer });
      on(platform, f);
      start();
      f.updater.emit('update-available', { version: '0.1.3' });
      f.updater.emit('update-downloaded', { version: '0.1.3' });
      if (platform === 'darwin') {
        assert.equal(f.dialogs.length, 0, 'macOS asks only after Squirrel.Mac accepted the code signature');
        f.electron.autoUpdater.emit('update-downloaded');
      }
      assert.equal(f.dialogs.length, 1);
      assert.equal(f.dialogs[0].message, 'chatmany 0.1.3 is ready to install.');
      assert.deepEqual(f.dialogs[0].buttons, ['Restart Now', 'Later']);
      await settle();
      await settle();
      assert.deepEqual(f.installs, answer === 0 ? [[true, true]] : []);
      assert.equal(f.updater.autoInstallOnAppQuit, true, 'Later: the update installs when the app quits');
      vi.advanceTimersByTime(DAY);
      assert.equal(f.updater.checks, 1, 'no new check while an update waits for the restart');
    });
  }
}
