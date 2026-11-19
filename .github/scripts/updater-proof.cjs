// CI only (.github/workflows/updater-proof.yml). Not part of the app.
//
// Proves chatmany's self-updater (desktop/publik-updater.cjs) on a real runner, against the INSTALLED
// test build N of the app. The test build carries no publik app token and the proof never signs in: the
// test hook (PUBLIK_UPDATER_TEST) starts no window, no publik and no Instagram. Copied from the publik
// updater template (Blueturboguy07/surfcam) with chatmany's names; the mac feed lists BOTH architectures,
// so the run also checks that the app took the zip of its own architecture.
//
//   prepare   makes the refused feeds from the good (signed) feed:
//               tampered-feed        the good feed with one byte changed, with the good .sig
//               other-key            the good feed, signed by a key made on this runner
//               no-sig               the good feed with no .sig
//               one-byte-installer   a feed signed with the REAL key whose URL for this runner's installer
//                                    (--onebyte-of <file name>) points at a copy of it with one byte
//                                    changed (sha512 no longer matches)
//               other-identity       (macOS) a feed signed with the REAL key for N+1 re-signed with another
//                                    code-signing identity (Squirrel.Mac must refuse it)
//   run       starts N with PUBLIK_UPDATER_TEST=update for each refused feed (served from 127.0.0.1) and
//             checks that it refuses and stays on N; then for the good feed (the GitHub prerelease) and
//             checks that it downloads, installs and that the installed app then reports N+1. On macOS it
//             also compares bundle ID, designated requirement and signing authority before and after.
//
//   node updater-proof.cjs check-build --asar <resources/app.asar> --version <N>
//   node updater-proof.cjs prepare --good <dir> --feed latest.yml --onebyte-of <file name> --onebyte-url <url>
//        [--other-identity <dir>] --out <dir>
//   node updater-proof.cjs run --app <installed executable> [--bundle <installed .app> --arch arm64|x64] --old <N>
//        --new <N+1> --good-url <url/> --cases <dir> --out <result.json> --logs <dir>
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const FEED_SCRIPT = path.join(ROOT, 'desktop', 'scripts', 'publik-update-feed.cjs');
const BUNDLE_ID = 'com.publikhq.chatmany';
const TAURI_CLI = '@tauri-apps/cli@2.12.4';
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, '')] = argv[i + 1];
  return o;
}
const log = (...a) => console.log('[proof]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- prepare

function signWith(file, env, publicKey) {
  const r = spawnSync(process.execPath, [FEED_SCRIPT, 'sign', file, ...(publicKey ? ['--public-key', publicKey] : [])], { env: { ...process.env, ...env }, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`signing ${file} failed`);
}

function prepare(o) {
  const feed = o.feed;
  const good = fs.readFileSync(path.join(o.good, feed));
  const goodSig = fs.readFileSync(path.join(o.good, `${feed}.sig`));
  const text = good.toString('utf8');
  const dir = (name) => { const d = path.join(o.out, name); fs.mkdirSync(d, { recursive: true }); return d; };

  // 1. one byte of the signed feed changed (a digit of the first file size), the good signature kept
  const tampered = Buffer.from(good);
  const at = text.indexOf('size: ') + 'size: '.length;
  tampered[at] = tampered[at] === 0x39 ? 0x38 : tampered[at] + 1;
  fs.writeFileSync(path.join(dir('tampered-feed'), feed), tampered);
  fs.writeFileSync(path.join(dir('tampered-feed'), `${feed}.sig`), goodSig);

  // 2. signed by another key: a throwaway key made here, with tauri's own generator
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'otherkey-'));
  const pass = crypto.randomBytes(16).toString('hex');
  const g = spawnSync('npx', ['--yes', TAURI_CLI, 'signer', 'generate', '-w', path.join(tmp, 'other.key'), '-p', pass, '--ci'], { stdio: ['ignore', 'ignore', 'inherit'], shell: isWin, env: { ...process.env, CI: 'true' } });
  if (g.status !== 0) throw new Error('tauri signer generate failed');
  fs.writeFileSync(path.join(dir('other-key'), feed), good);
  signWith(path.join(dir('other-key'), feed), { PUBLIK_UPDATE_KEY: fs.readFileSync(path.join(tmp, 'other.key'), 'utf8'), PUBLIK_UPDATE_KEY_PASSWORD: pass }, path.join(tmp, 'other.key.pub'));

  // 3. no signature at all
  fs.writeFileSync(path.join(dir('no-sig'), feed), good);

  // 4. a validly signed feed (real key) whose file for this runner points at an installer with one byte
  //    changed (the mac feed lists two architectures: the app takes the one of its own)
  const urls = [...text.matchAll(/url: '([^']+)'/g)].map((m) => m[1]);
  const target = urls.find((u) => u.endsWith(`/${encodeURIComponent(o['onebyte-of'])}`));
  if (!target) throw new Error(`the good feed lists no ${o['onebyte-of']}: ${urls.join(', ')}`);
  const onebyte = text.split(target).join(o['onebyte-url']);
  fs.writeFileSync(path.join(dir('one-byte-installer'), feed), onebyte);
  signWith(path.join(dir('one-byte-installer'), feed), {}); // PUBLIK_UPDATE_KEY from the job

  // 5. macOS: N+1 re-signed with another identity, feed signed with the real key
  if (o['other-identity']) {
    fs.copyFileSync(path.join(o['other-identity'], feed), path.join(dir('other-identity'), feed));
    signWith(path.join(dir('other-identity'), feed), {});
  }
  log('cases:', fs.readdirSync(o.out).join(', '));
}

/** Flips one byte in the middle of a copy of `src`. */
function oneByte(src, dst) {
  const data = fs.readFileSync(src);
  const at = data.length >> 1;
  data[at] ^= 0xff;
  fs.writeFileSync(dst, data);
  log(`one byte flipped at offset ${at}: ${path.basename(dst)}`);
}

// ---------------------------------------------------------------- run

function serve(dir) {
  const requests = [];
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    requests.push(p);
    const f = path.resolve(root, `.${p}`);
    if (!f.startsWith(root + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': 'text/plain' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, origin: `http://127.0.0.1:${server.address().port}` })));
}

function launch(app, env, { timeoutMs, logFile }) {
  return new Promise((resolve) => {
    const child = spawn(app, [], { env: { ...process.env, DO_NOT_TRACK: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: !isWin });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => {
      out += '\n[proof] TIMEOUT: killing the app\n';
      try { if (isWin) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); else process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, timeoutMs);
    child.on('exit', (code, signal) => { clearTimeout(timer); if (logFile) fs.writeFileSync(logFile, out); resolve({ code, signal, out }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, signal: null, out: out + String(e) }); });
  });
}

async function runHook(app, mode, extraEnv, name, o) {
  const resultFile = path.join(o.logs, `${name}.result.json`);
  fs.rmSync(resultFile, { force: true });
  const r = await launch(app, { PUBLIK_UPDATER_TEST: mode, PUBLIK_UPDATER_RESULT: resultFile, ...extraEnv }, { timeoutMs: mode === 'report' ? 90_000 : 420_000, logFile: path.join(o.logs, `${name}.log`) });
  let result = null;
  try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch {}
  return { exit: r.code, signal: r.signal, result };
}

const plist = (bundle, key) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(bundle, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();

function macIdentity(bundle) {
  const dv = spawnSync('codesign', ['-dvv', bundle], { encoding: 'utf8' }).stderr;
  const dr = spawnSync('codesign', ['-d', '-r-', bundle], { encoding: 'utf8' });
  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', bundle], { encoding: 'utf8' });
  const pick = (re) => (dv.match(re) || [])[1] || null;
  const xattrs = spawnSync('xattr', [bundle], { encoding: 'utf8' }).stdout.trim();
  return {
    version: plist(bundle, 'CFBundleShortVersionString'),
    bundleId: plist(bundle, 'CFBundleIdentifier'),
    signedIdentifier: pick(/^Identifier=(.*)$/m),
    authority: [...dv.matchAll(/^Authority=(.*)$/gm)].map((m) => m[1]),
    teamIdentifier: pick(/^TeamIdentifier=(.*)$/m),
    designatedRequirement: ((dr.stdout + dr.stderr).match(/designated => (.*)/) || [])[1] || null,
    codesignVerify: verify.status === 0 ? 'valid' : `invalid: ${(verify.stderr || '').trim()}`,
    quarantine: /com\.apple\.quarantine/.test(xattrs),
  };
}

function winInstalledVersion() {
  const ps = "Get-ItemProperty HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'chatmany*' } | ForEach-Object { $_.DisplayVersion }";
  return spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).stdout.trim();
}
function winInstallerRunning() {
  const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout;
  return /"(chatmany-[^"]*-setup[^"]*|Au_\.exe|Un_A\.exe)"/i.test(r);
}

/** The version the installed copy carries on disk (macOS: Info.plist; Windows: the uninstall entry). */
function installedVersion(o) {
  return isMac ? plist(o.bundle, 'CFBundleShortVersionString') : winInstalledVersion();
}

async function waitForInstall(o) {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    let v = null;
    try { v = installedVersion(o); } catch {} // ShipIt may be swapping the bundle right now
    const busy = isWin && winInstallerRunning();
    if (v === o.new && !busy) return true;
    await sleep(3000);
  }
  return false;
}

async function run(o) {
  fs.mkdirSync(o.logs, { recursive: true });
  const checks = [];
  const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); };
  const feed = isMac ? 'latest-mac.yml' : 'latest.yml';
  const summary = { platform: process.platform, arch: process.arch, old: o.old, new: o.new, goodUrl: o['good-url'], checks, cases: {} };

  const before = await runHook(o.app, 'report', {}, '0-report-before', o);
  check('the installed app reports N before any update', before.result && before.result.version === o.old, before.result && before.result.version);
  if (isMac) summary.identityBefore = macIdentity(o.bundle);

  const { server, requests, origin } = await serve(o.cases);
  const refused = [
    ['tampered-feed', /not signed by the publik update key: signature does not match the file/, 'ERR_PUBLIK_FEED_SIGNATURE', false],
    ['other-key', /not signed by the publik update key: signed with key [0-9A-F]{16}, not with the update key F5E0515C77912BD0/, 'ERR_PUBLIK_FEED_SIGNATURE', false],
    ['no-sig', new RegExp(`Cannot get ${feed.replace('.', '\\.')}\\.sig`), 'ERR_PUBLIK_FEED_SIGNATURE', false],
    ['one-byte-installer', /sha512 checksum mismatch/, 'ERR_CHECKSUM_MISMATCH', true],
    ...(isMac && fs.existsSync(path.join(o.cases, 'other-identity')) ? [['other-identity', /code signature|requirement|did not pass validation/i, null, true]] : []),
  ];
  let n = 1;
  for (const [name, re, code, downloads] of refused) {
    const before = requests.length;
    const r = await runHook(o.app, 'update', { PUBLIK_UPDATE_URL: `${origin}/${name}/` }, `${n++}-${name}`, o);
    const res = r.result || {};
    const events = (res.events || []).map((e) => e.name);
    summary.cases[name] = { outcome: res.outcome, code: res.code, message: res.message, events, feedRequests: requests.slice(before), verifiedFeed: res.verifiedFeed || null };
    check(`${name}: the app refuses the update`, res.outcome === 'error' && re.test(res.message || '') && (code == null || res.code === code), `${res.outcome} ${res.code || ''} ${String(res.message || '').split('\n')[0]}`);
    check(`${name}: ${downloads ? 'it downloaded, then refused the file' : 'it refused before any download'}`, downloads ? events.includes('update-available') : !events.includes('update-available'), events.join(' > '));
    const after = await runHook(o.app, 'report', {}, `${n++}-${name}-report`, o);
    check(`${name}: the app stays on N`, after.result && after.result.version === o.old && installedVersion(o) === o.old, `${after.result && after.result.version} / on disk ${installedVersion(o)}`);
  }
  server.close();

  // The good feed: the signed feed on the GitHub prerelease, absolute asset URLs.
  const good = await runHook(o.app, 'update', { PUBLIK_UPDATE_URL: o['good-url'] }, `${n++}-good`, o);
  const g = good.result || {};
  summary.cases.good = { outcome: g.outcome, newVersion: g.newVersion, events: (g.events || []).map((e) => e.name), verifiedFeed: g.verifiedFeed || null, message: g.message };
  check('good: the feed signature verifies with the publik key', g.verifiedFeed && g.verifiedFeed.keyId === 'F5E0515C77912BD0' && g.verifiedFeed.feed === feed && g.verifiedFeed.version === o.new, g.verifiedFeed);
  check('good: N finds N+1, downloads it (sha512 checked) and starts the install', g.outcome === 'installing' && g.newVersion === o.new, `${g.outcome} ${g.newVersion || g.message || ''}`);
  if (isMac) {
    check('good: Squirrel.Mac accepted the code signature of N+1', (g.events || []).some((e) => e.name === 'squirrel-accepted'));
    const got = ((g.events || []).find((e) => e.name === 'update-downloaded') || {}).file;
    check(`good: from a feed with both mac architectures, the app took the ${o.arch} zip`, got === `chatmany-${o.new}-mac-${o.arch}.zip`, got);
  }
  const installed = await waitForInstall(o);
  check('good: the installed copy on disk becomes N+1', installed, installedVersion(o));
  if (isMac) {
    summary.identityAfter = macIdentity(o.bundle);
    for (const f of ['ShipIt_stderr.log', 'ShipIt_stdout.log']) {
      const p = path.join(os.homedir(), 'Library', 'Caches', `${summary.identityBefore.bundleId}.ShipIt`, f);
      if (fs.existsSync(p)) fs.copyFileSync(p, path.join(o.logs, f));
    }
    if (summary.identityAfter.quarantine) log('note: the updated bundle carries com.apple.quarantine');
  }
  const after = await runHook(o.app, 'report', {}, `${n++}-report-after`, o);
  check('good: the installed app now reports N+1', after.result && after.result.version === o.new, after.result && after.result.version);
  check('good: same install location', after.result && before.result && after.result.execPath === before.result.execPath, after.result && after.result.execPath);
  if (isMac) {
    const a = summary.identityBefore;
    const b = summary.identityAfter;
    check('mac: same bundle ID after the update', a.bundleId === b.bundleId && b.bundleId === BUNDLE_ID, b.bundleId);
    check('mac: same designated requirement (the safeStorage keychain item and TCC key on it)', a.designatedRequirement && a.designatedRequirement === b.designatedRequirement, b.designatedRequirement);
    check('mac: same signing authority', JSON.stringify(a.authority) === JSON.stringify(b.authority) && a.authority.length > 0, b.authority);
    check('mac: the updated bundle passes codesign --verify --deep --strict', b.codesignVerify === 'valid', b.codesignVerify);
  }

  summary.pass = checks.every((c) => c.pass);
  fs.writeFileSync(o.out, JSON.stringify(summary, null, 1));
  log(`${checks.filter((c) => c.pass).length}/${checks.length} checks passed`);
  process.exit(summary.pass ? 0 : 1);
}

// ---------------------------------------------------------------- check-build

/** Reads one file out of an app.asar (layout as in desktop/scripts/has-app-token.mjs). */
function asarReader(file) {
  const fd = fs.openSync(file, 'r');
  const read = (pos, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return b; };
  const prefix = read(0, 16);
  const headerSize = prefix.readUInt32LE(4);
  const table = JSON.parse(read(16, prefix.readUInt32LE(12)).toString('utf8'));
  const entry = (p) => p.split('/').reduce((node, part) => node && node.files && node.files[part], table);
  return {
    has: (p) => !!entry(p),
    text: (p) => { const e = entry(p); if (!e || e.unpacked) return null; return read(8 + headerSize + Number(e.offset), e.size).toString('utf8'); },
    close: () => fs.closeSync(fd),
  };
}

/**
 * The test build carries the updater and nothing that could sign in: electron-updater and blakejs in
 * node_modules, the signed-feed provider and the slug in main.cjs, "publikUpdaterTest": true, the
 * expected version, the publik feed URL in app-update.yml, and NO publik app token.
 */
function checkBuild(o) {
  const a = asarReader(o.asar);
  const pkg = JSON.parse(a.text('package.json'));
  const main = a.text('dist-electron/main.cjs') || '';
  const updateYml = fs.readFileSync(path.join(path.dirname(o.asar), 'app-update.yml'), 'utf8');
  a.close();
  const checks = [
    ['node_modules/electron-updater is packed', a.has('node_modules/electron-updater/package.json')],
    ['node_modules/blakejs is packed', a.has('node_modules/blakejs/package.json')],
    ['main.cjs holds the signed-feed provider and the slug chatmany', main.includes('PublikSignedFeedProvider') && main.includes('"chatmany"')],
    [`package.json: version ${o.version}, publikUpdaterTest true`, pkg.version === o.version && pkg.publikUpdaterTest === true],
    ['package.json: no publik app token (this build cannot sign in)', !(typeof (pkg.publik || {}).appToken === 'string' && pkg.publik.appToken.trim())],
    ['app-update.yml: the publik feed of chatmany', /url: https:\/\/publikhq\.com\/api\/updates\/chatmany\/?\s*$/m.test(updateYml)],
  ];
  for (const [name, pass] of checks) log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
  log(`app-update.yml:\n${updateYml.trim()}`);
  process.exit(checks.every(([, pass]) => pass) ? 0 : 1);
}

const [cmd, ...rest] = process.argv.slice(2);
const o = args(rest);
if (cmd === 'check-build') checkBuild(o);
else if (cmd === 'prepare') prepare(o);
else if (cmd === 'one-byte') oneByte(o.src, o.dst);
else if (cmd === 'run') run(o).catch((e) => { console.error(e); process.exit(1); });
else { console.error('usage: updater-proof.cjs check-build|prepare|one-byte|run ...'); process.exit(2); }
