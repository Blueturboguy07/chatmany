#!/usr/bin/env node
// publik-release-check.cjs — the file checks of scripts/publik-release.sh (docs/updates.md › Cut a release).
// No dependencies; it never starts the app and never prints the app token or a key.
//
//   record <file> <dir>                    writes <dir>/<name>.json: name, size, sha512 (base64), sha256 (hex)
//   write-feed <record dir> <out dir> --app <slug> --version X.Y.Z --base <download URL/>
//                                          latest.yml (the Windows installer) and latest-mac.yml (the zips, then
//                                          the dmgs, arm64 before x64) from the records, with absolute URLs,
//                                          in the format of scripts/publik-update-feed.cjs (its feedText)
//   feed <dir> --app <slug> --version X.Y.Z --base <URL/> --files <name,name,...>
//                                          checks latest.yml and latest-mac.yml in <dir>: the signature (.sig) with
//                                          the public key in publik-update-verify.cjs, the key ID, version,
//                                          publikApp, absolute URLs under --base, exactly --files, zips first
//   match <feed dir> <file>                the file's sha512 and size are the ones the signed feed gives
//   exe <file> --version X.Y.Z             the Windows installer's ProductVersion / FileVersion is X.Y.Z(.0)
//   token <app.asar>                       "pat_<slug>_ sha256:<16 hex> length:<n>" of the packed app token
//                                          (package.json publik.appToken): a fingerprint, never the token
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyMinisign, PUBLIK_UPDATE_PUBLIC_KEYS } = require('../publik-update-verify.cjs');
const { feedText } = require('./publik-update-feed.cjs');

const KEY_ID = 'F5E0515C77912BD0'; // the publik update key (docs/updates.md › Rotate the key)
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) fails++; return cond; };
const die = (msg) => { console.error(`publik-release-check: ${msg}`); process.exit(2); };

function opts(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
    else o._.push(argv[i]);
  }
  return o;
}

function hashes(file) {
  const s512 = crypto.createHash('sha512');
  const s256 = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(8 << 20);
  let size = 0;
  for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) {
    s512.update(buf.subarray(0, n));
    s256.update(buf.subarray(0, n));
    size += n;
  }
  fs.closeSync(fd);
  return { size, sha512: s512.digest('base64'), sha256: s256.digest('hex') };
}

const ARCHS = ['arm64', 'x64'];
const archOf = (name) => (/-mac-(arm64|x64)\.(zip|dmg)$/.exec(name) || [])[1];
const macOrder = (a, b) => (a.endsWith('.zip') === b.endsWith('.zip') ? ARCHS.indexOf(archOf(a)) - ARCHS.indexOf(archOf(b)) : a.endsWith('.zip') ? -1 : 1);

function record(file, dir) {
  if (!fs.existsSync(file)) die(`${file} does not exist`);
  fs.mkdirSync(dir, { recursive: true });
  const r = { name: path.basename(file), ...hashes(file) };
  fs.writeFileSync(path.join(dir, `${r.name}.json`), JSON.stringify(r, null, 1));
  console.log(`recorded ${r.name}: ${r.size} bytes, sha256 ${r.sha256}`);
}

function writeFeed(recDir, out, o) {
  const { app, version, base } = o;
  if (!app || !version || !base || !/^https:\/\/.+\/$/.test(base)) die('write-feed needs --app, --version and --base https://.../');
  const recs = fs.readdirSync(recDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(recDir, f), 'utf8')));
  const entry = (r) => {
    if (!r.name.includes(`-${version}-`)) die(`${r.name} does not carry the version ${version}`);
    return { url: new URL(encodeURIComponent(r.name), base).href, sha512: r.sha512, size: r.size };
  };
  const exes = recs.filter((r) => r.name.endsWith('.exe'));
  const mac = recs.filter((r) => /-mac-(arm64|x64)\.(zip|dmg)$/.test(r.name)).sort((a, b) => macOrder(a.name, b.name));
  if (exes.length !== 1) die(`want one Windows installer record, have ${exes.length}`);
  if (mac.length !== 4) die(`want four mac records (arm64 + x64, zip + dmg), have ${mac.map((r) => r.name).join(', ')}`);
  const releaseDate = new Date().toISOString();
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'latest.yml'), feedText({ app, version, entries: exes.map(entry), releaseDate }));
  fs.writeFileSync(path.join(out, 'latest-mac.yml'), feedText({ app, version, entries: mac.map(entry), releaseDate }));
  console.log(`wrote ${path.join(out, 'latest.yml')} (${exes[0].name}) and ${path.join(out, 'latest-mac.yml')} (${mac.map((r) => r.name).join(', ')})`);
}

function parseFeed(text) {
  return {
    version: (/^version: '([^']+)'/m.exec(text) || [])[1],
    app: (/^publikApp: '([^']+)'/m.exec(text) || [])[1],
    files: [...text.matchAll(/- url: '([^']+)'\n\s+sha512: '([^']+)'\n\s+size: (\d+)/g)].map((m) => ({ url: m[1], sha512: m[2], size: Number(m[3]) })),
    path: (/^path: '([^']+)'/m.exec(text) || [])[1],
    sha512: (/^sha512: '([^']+)'/m.exec(text) || [])[1],
  };
}

function feed(dir, o) {
  const want = String(o.files || '').split(',').filter(Boolean);
  const listed = [];
  for (const name of ['latest.yml', 'latest-mac.yml']) {
    const file = path.join(dir, name);
    if (!ok(fs.existsSync(file) && fs.existsSync(`${file}.sig`), `${name} and ${name}.sig are there`)) continue;
    const bytes = fs.readFileSync(file);
    try {
      const v = verifyMinisign(bytes, fs.readFileSync(`${file}.sig`, 'utf8'), PUBLIK_UPDATE_PUBLIC_KEYS, { file: name });
      ok(v.keyId === KEY_ID, `${name}.sig verifies with the app's public key (key ${v.keyId}; ${v.trustedComment.replace(/\t/g, ' ')})`);
    } catch (e) {
      ok(false, `${name}.sig: ${e.message}`);
    }
    const f = parseFeed(bytes.toString('utf8'));
    ok(f.version === o.version, `${name}: version ${f.version}`);
    ok(f.app === o.app, `${name}: publikApp ${f.app}`);
    ok(f.files.length > 0 && f.path === f.files[0].url && f.sha512 === f.files[0].sha512, `${name}: path and sha512 name the first file (${f.files.length} files)`);
    const names = f.files.map((e) => decodeURIComponent(e.url.slice(o.base.length)));
    ok(f.files.every((e) => e.url.startsWith(o.base)), `${name}: every URL is an absolute GitHub URL under ${o.base}`);
    if (name === 'latest-mac.yml') ok(names.join(',') === [...names].sort(macOrder).join(','), `latest-mac.yml: the zips come first (Squirrel.Mac installs from them): ${names.join(', ')}`);
    else ok(names.length === 1 && names[0].endsWith('.exe'), `latest.yml: the Windows installer ${names.join(', ')}`);
    listed.push(...names);
  }
  ok([...listed].sort().join(',') === [...want].sort().join(','), `the feeds list exactly: ${want.join(', ')}`);
}

function match(dir, file) {
  const name = path.basename(file);
  let entry = null;
  for (const f of ['latest.yml', 'latest-mac.yml']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    entry = parseFeed(fs.readFileSync(p, 'utf8')).files.find((e) => decodeURIComponent(e.url.split('/').pop()) === name) || entry;
  }
  if (!ok(entry, `${name} is in the signed feed`)) return;
  const h = hashes(file);
  ok(h.sha512 === entry.sha512 && h.size === entry.size, `${name}: sha512 and size (${h.size}) match the signed feed`);
}

/** The strings of a PE file's VS_VERSIONINFO (UTF-16LE key, padding to 32 bits, UTF-16LE value). */
function peStrings(data, key) {
  const k = Buffer.from(`${key}\0`, 'utf16le');
  const found = [];
  for (let i = data.indexOf(k); i >= 0; i = data.indexOf(k, i + 1)) {
    let j = i + k.length;
    while (j % 4) j++;
    let end = j;
    while (end + 1 < data.length && !(data[end] === 0 && data[end + 1] === 0)) end += 2;
    const v = data.subarray(j, end).toString('utf16le');
    if (v && !found.includes(v)) found.push(v);
  }
  return found;
}

function exe(file, o) {
  const data = fs.readFileSync(file);
  const pv = peStrings(data, 'ProductVersion');
  const fv = peStrings(data, 'FileVersion');
  const same = (v) => v === o.version || v === `${o.version}.0`;
  ok(pv.some(same) && fv.some(same), `${path.basename(file)}: ProductVersion ${pv.join(', ') || '(none)'}, FileVersion ${fv.join(', ') || '(none)'} (want ${o.version})`);
}

function asarFile(asar, inner) {
  const fd = fs.openSync(asar, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const json = Buffer.alloc(head.readUInt32LE(12));
    fs.readSync(fd, json, 0, json.length, 16);
    let node = JSON.parse(json.toString('utf8'));
    for (const part of inner.split('/')) node = node && node.files && node.files[part];
    if (!node || node.offset === undefined) return null;
    const data = Buffer.alloc(node.size);
    fs.readSync(fd, data, 0, node.size, 8 + head.readUInt32LE(4) + Number(node.offset));
    return data;
  } finally {
    fs.closeSync(fd);
  }
}

function token(asar) {
  const pkg = JSON.parse(asarFile(asar, 'package.json').toString('utf8'));
  const t = pkg.publik && typeof pkg.publik.appToken === 'string' ? pkg.publik.appToken.trim() : '';
  const m = /^pat_([a-z0-9-]+)_[a-z0-9]{32}$/.exec(t);
  console.log(`${m ? `pat_${m[1]}_` : 'NO-TOKEN'} sha256:${crypto.createHash('sha256').update(t).digest('hex').slice(0, 16)} length:${t.length}`);
  if (!m) fails++;
}

const [cmd, ...rest] = process.argv.slice(2);
const o = opts(rest);
if (cmd === 'record') record(o._[0], o._[1]);
else if (cmd === 'write-feed') writeFeed(o._[0], o._[1], o);
else if (cmd === 'feed') feed(o._[0], o);
else if (cmd === 'match') match(o._[0], o._[1]);
else if (cmd === 'exe') exe(o._[0], o);
else if (cmd === 'token') token(o._[0]);
else die('usage: publik-release-check.cjs record|write-feed|feed|match|exe|token ... (see the top of this file)');
process.exit(fails ? 1 : 0);
