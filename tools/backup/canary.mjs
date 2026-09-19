// canary.mjs — synthetic, clearly-labelled files for restore drills (never a real certificate), plus structural
// validators. "Opens" here means: a PDF with a correct header, a cross-reference table found at its startxref
// offset, a trailer naming a /Root, and %%EOF; a PNG with a valid signature, IHDR first, correct CRC on every
// chunk, IDAT that inflates to exactly the expected scanline bytes, and IEND. That is what a viewer needs to
// render them; it is not a visual inspection.
import { deflateSync, inflateSync, crc32 } from 'node:zlib';

export function makePdf(label) {
  const lines = ['SYNTHETIC BACKUP CANARY - NOT A CERTIFICATE', String(label).replace(/[()\\]/g, ' '), 'Demohub storage backup restore drill'];
  const content = 'BT /F1 14 Tf 60 740 Td 18 TL\n' + lines.map(l => `(${l}) Tj T*`).join('\n') + '\nET\n% ' + 'x'.repeat(3600) + '\n';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const off = [];
  objs.forEach((o, i) => { off.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
export function validatePdf(buf) {
  const s = buf.toString('latin1'); const problems = [];
  if (!/^%PDF-1\.[0-9]/.test(s)) problems.push('no %PDF header');
  const m = s.match(/startxref\s+(\d+)\s+%%EOF\s*$/); if (!m) problems.push('no startxref/%%EOF');
  else { const at = Number(m[1]); if (s.slice(at, at + 4) !== 'xref') problems.push('startxref does not point at xref'); const t = s.slice(at); if (!/trailer\s*<<[^>]*\/Root\s+\d+\s+\d+\s+R/.test(t)) problems.push('trailer has no /Root'); const n = (t.match(/^\d{10} \d{5} [nf] $/gm) || []).length; const decl = (t.match(/xref\s+0\s+(\d+)/) || [])[1]; if (String(n) !== decl) problems.push(`xref declares ${decl} entries, found ${n}`);
    for (const e of (t.match(/^(\d{10}) \d{5} n $/gm) || [])) { const o = Number(e.slice(0, 10)); if (!/^\d+ 0 obj/.test(s.slice(o, o + 12))) problems.push('xref offset ' + o + ' is not an object'); } }
  return { ok: problems.length === 0, problems };
}
const chunk = (type, data) => { const t = Buffer.from(type, 'ascii'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0); return Buffer.concat([len, t, data, crc]); };
export function makePng(seed = 1) {
  const w = 32, h = 32; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;   // 8-bit RGB
  const raw = Buffer.alloc(h * (1 + w * 3)); for (let y = 0; y < h; y++) { raw[y * (1 + w * 3)] = 0; for (let x = 0; x < w; x++) { const o = y * (1 + w * 3) + 1 + x * 3; raw[o] = (x * 8 + seed) & 255; raw[o + 1] = (y * 8) & 255; raw[o + 2] = (seed * 37) & 255; } }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('Comment\0synthetic backup canary, not a real logo')), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export function validatePng(buf) {
  const problems = []; if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return { ok: false, problems: ['bad signature'] };
  let off = 8, first = true, w = 0, h = 0, idat = [], ended = false;
  while (off + 12 <= buf.length) { const len = buf.readUInt32BE(off); const type = buf.subarray(off + 4, off + 8).toString('ascii'); const data = buf.subarray(off + 8, off + 8 + len); if (off + 12 + len > buf.length) { problems.push('truncated chunk ' + type); break; }
    if ((crc32(buf.subarray(off + 4, off + 8 + len)) >>> 0) !== buf.readUInt32BE(off + 8 + len)) problems.push('bad CRC in ' + type);
    if (first && type !== 'IHDR') problems.push('IHDR is not first'); first = false;
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); if (data[8] !== 8 || data[9] !== 2) problems.push('unexpected colour type'); }
    if (type === 'IDAT') idat.push(data); if (type === 'IEND') { ended = true; break; } off += 12 + len; }
  if (!ended) problems.push('no IEND');
  try { const raw = inflateSync(Buffer.concat(idat)); if (raw.length !== h * (1 + w * 3)) problems.push(`pixel data is ${raw.length} bytes, expected ${h * (1 + w * 3)}`); } catch (e) { problems.push('IDAT does not inflate'); }
  return { ok: problems.length === 0, problems };
}
