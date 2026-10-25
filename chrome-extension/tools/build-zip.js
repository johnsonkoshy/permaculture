#!/usr/bin/env node
/*
 * Packs the extension into dist/ebpg-posting-helper.zip for sharing. No dependencies and no
 * zip tool needed (works the same on macOS, Windows and Linux):
 *   node tools/build-zip.js            (or: npm run zip)
 * The zip holds only what Chrome needs: manifest.json, src/, pages/, icons/ and README.md.
 * Unzip it, then use chrome://extensions -> Load unpacked on the unzipped folder.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { crc32 } = require('./make-icons.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'ebpg-posting-helper.zip');
const INCLUDE = ['manifest.json', 'README.md', 'src', 'pages', 'icons'];
const SKIP = /(^|\/)(\.[^/]*|node_modules|tests?|dist)(\/|$)/;

function walk(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [rel];
  return fs.readdirSync(abs).sort().flatMap(name => walk(path.posix.join(rel, name)));
}

function listFiles() {
  return INCLUDE.flatMap(walk).filter(f => !SKIP.test(f));
}

// Fixed timestamp (2026-01-01 00:00) so the same files always give the same zip.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function buildZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const name of files) {
    const data = fs.readFileSync(path.join(ROOT, name));
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

if (require.main === module) {
  const files = listFiles();
  if (!files.includes('manifest.json')) { console.error('manifest.json is missing'); process.exit(1); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const zip = buildZip(files);
  fs.writeFileSync(OUT, zip);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} (${files.length} files, ${Math.round(zip.length / 1024)} KB)`);
}

module.exports = { listFiles, buildZip, OUT };
