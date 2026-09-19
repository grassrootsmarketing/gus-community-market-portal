// tar.mjs — minimal ustar writer/reader for backup snapshots. Entry names are NEVER derived from cloud object
// keys: only `manifest.json` and `objects/<sha256>` are written, and the reader refuses anything else, so an
// archive can never direct a write outside the extraction root.
const NAME_OK = /^(manifest\.json|objects\/[0-9a-f]{64})$/;
const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
export function tarPack(entries) {                       // entries: [{ name, data: Buffer }]
  const blocks = [];
  for (const { name, data } of entries) {
    if (!NAME_OK.test(name)) throw new Error('tar: refused entry name ' + JSON.stringify(name));
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'ascii'); h.write(oct(0o600, 8), 100); h.write(oct(0, 8), 108); h.write(oct(0, 8), 116);
    h.write(oct(data.length, 12), 124); h.write(oct(0, 12), 136); h.fill(' ', 148, 156); h.write('0', 156);
    h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
export function tarUnpack(buf) {
  const out = []; let off = 0; const seen = new Set();
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every(b => b === 0)) break;
    const name = h.subarray(0, 100).toString('ascii').replace(/\0.*$/, '');
    const prefix = h.subarray(345, 500).toString('ascii').replace(/\0.*$/, '');
    const type = String.fromCharCode(h[156] || 48);
    if (prefix || !NAME_OK.test(name) || type !== '0') throw new Error('tar: refused entry ' + JSON.stringify({ name, prefix, type }));
    if (seen.has(name)) throw new Error('tar: duplicate entry ' + name); seen.add(name);
    const stored = parseInt(h.subarray(148, 154).toString('ascii'), 8); const c = Buffer.from(h); c.fill(' ', 148, 156); let sum = 0; for (const b of c) sum += b;
    if (stored !== sum) throw new Error('tar: header checksum mismatch for ' + name);
    const size = parseInt(h.subarray(124, 135).toString('ascii').replace(/\0.*$/, ''), 8);
    if (!Number.isFinite(size) || size < 0 || off + 512 + size > buf.length) throw new Error('tar: bad size for ' + name);
    out.push({ name, data: Buffer.from(buf.subarray(off + 512, off + 512 + size)) });
    off += 512 + size + ((512 - (size % 512)) % 512);
  }
  return out;
}
