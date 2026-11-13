// Construit le paquet de l'extension (dist/Formagic-<version>.zip) sans les outils de développement.
// Usage : node dev/package.mjs [dossier de sortie]   (Node 22.2+, aucune dépendance)
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, crc32 } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const include = [
  'manifest.json', 'background.js', 'popup.html', 'popup.js', 'viewer.html',
  'css', 'js', 'icons', 'lib', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md',
];
const { version } = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const outDir = path.resolve(process.argv[2] || path.join(root, 'dist'));
const out = path.join(outDir, `Formagic-${version}.zip`);

function* walk(rel) {
  const abs = path.join(root, rel);
  if (statSync(abs).isDirectory()) {
    for (const name of readdirSync(abs).sort()) yield* walk(path.join(rel, name));
  } else yield rel;
}

// Format ZIP minimal (deflate, sans chiffrement ni zip64 : largement suffisant pour une extension)
const local = [], central = [];
let offset = 0;
const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
let count = 0;
for (const entry of include) {
  for (const rel of walk(entry)) {
    const name = Buffer.from(rel.split(path.sep).join('/'), 'utf8');
    const data = readFileSync(path.join(root, rel));
    const packed = deflateRawSync(data, { level: 9 });
    const stored = packed.length >= data.length;
    const body = stored ? data : packed;
    const mtime = statSync(path.join(root, rel)).mtime;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(stored ? 0 : 8, 8); head.writeUInt16LE(dosTime(mtime), 10); head.writeUInt16LE(dosDate(mtime), 12);
    head.writeUInt32LE(crc32(data), 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    head.copy(cen, 10, 8, 28); // méthode, date, CRC, tailles, longueur du nom
    cen.writeUInt32LE(offset, 42);
    local.push(head, name, body);
    central.push(cen, name);
    offset += head.length + name.length + body.length;
    count++;
  }
}
const cenSize = central.reduce((s, b) => s + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
end.writeUInt32LE(cenSize, 12); end.writeUInt32LE(offset, 16);
mkdirSync(outDir, { recursive: true });
writeFileSync(out, Buffer.concat([...local, ...central, end]));
console.log(`${out} (${count} fichiers, ${(statSync(out).size / 1048576).toFixed(1)} Mo)`);
