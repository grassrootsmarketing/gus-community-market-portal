// age.mjs — a small, dependency-free implementation of the age v1 file format (https://age-encryption.org/v1)
// with X25519 recipients, so the backup runner needs ONLY the public recipient ("age1…") and the archive can be
// decrypted on any other device with the standard `age` tool and the private identity ("AGE-SECRET-KEY-1…").
// Primitives are Node's own crypto: X25519, HKDF-SHA256, HMAC-SHA256, ChaCha20-Poly1305.
import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

// ---- bech32 (BIP-173), no length limit, as used by age ------------------------------------------
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const polymod = (values) => { const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let chk = 1; for (const v of values) { const b = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i]; } return chk >>> 0; };
const hrpExpand = (hrp) => [...hrp].map(c => c.charCodeAt(0) >>> 5).concat([0], [...hrp].map(c => c.charCodeAt(0) & 31));
function convertBits(data, from, to, pad) { let acc = 0, bits = 0; const out = [], maxv = (1 << to) - 1; for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; out.push((acc >>> bits) & maxv); } } if (pad) { if (bits > 0) out.push((acc << (to - bits)) & maxv); } else if (bits >= from || ((acc << (to - bits)) & maxv)) throw new Error('bech32: invalid padding'); return out; }
export function bech32Encode(hrp, bytes) { const h = hrp.toLowerCase(); const data = convertBits([...bytes], 8, 5, true); const pm = polymod(hrpExpand(h).concat(data, [0, 0, 0, 0, 0, 0])) ^ 1; const chk = []; for (let i = 0; i < 6; i++) chk.push((pm >>> (5 * (5 - i))) & 31); return h + '1' + data.concat(chk).map(d => CHARSET[d]).join(''); }
export function bech32Decode(str) { if (str !== str.toLowerCase() && str !== str.toUpperCase()) throw new Error('bech32: mixed case'); const s = str.toLowerCase(); const pos = s.lastIndexOf('1'); if (pos < 1 || pos + 7 > s.length) throw new Error('bech32: malformed'); const hrp = s.slice(0, pos); const data = [...s.slice(pos + 1)].map(c => { const i = CHARSET.indexOf(c); if (i < 0) throw new Error('bech32: bad character'); return i; }); if (polymod(hrpExpand(hrp).concat(data)) !== 1) throw new Error('bech32: bad checksum'); return { hrp, bytes: Buffer.from(convertBits(data.slice(0, -6), 5, 8, false)) }; }

// ---- X25519 helpers ------------------------------------------------------------------------------
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex'), SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const privObj = (raw) => createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: 'der', type: 'pkcs8' });
const pubObj = (raw) => createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' });
const pubOfPriv = (raw) => createPublicKey(privObj(raw)).export({ format: 'der', type: 'spki' }).subarray(-32);
const x25519 = (privRaw, pubRaw) => { const s = diffieHellman({ privateKey: privObj(privRaw), publicKey: pubObj(pubRaw) }); if (s.every(b => b === 0)) throw new Error('age: low-order X25519 point'); return s; };
const hkdf = (ikm, salt, info, len = 32) => Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(info), len));
const b64 = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '');
const unb64 = (s) => { if (/[=\s]/.test(s)) throw new Error('age: non-canonical base64'); const b = Buffer.from(s, 'base64'); if (b64(b) !== s) throw new Error('age: non-canonical base64'); return b; };
const aead = (key, nonce, pt) => { const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 }); return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]); };
const unaead = (key, nonce, ct) => { if (ct.length < 16) throw new Error('age: short ciphertext'); const d = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 }); d.setAuthTag(ct.subarray(-16)); return Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]); };

export function generateIdentity() { const { privateKey } = generateKeyPairSync('x25519'); const raw = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32); return { identity: bech32Encode('age-secret-key-', raw).toUpperCase(), recipient: bech32Encode('age', pubOfPriv(raw)) }; }
export function recipientOf(identity) { const d = bech32Decode(identity.trim()); if (d.hrp !== 'age-secret-key-' || d.bytes.length !== 32) throw new Error('age: not an identity'); return bech32Encode('age', pubOfPriv(d.bytes)); }
export function parseRecipient(recipient) { const d = bech32Decode(String(recipient).trim()); if (d.hrp !== 'age' || d.bytes.length !== 32) throw new Error('age: not an X25519 recipient (expected age1…)'); return d.bytes; }

const CHUNK = 64 * 1024;
const streamNonce = (counter, last) => { const n = Buffer.alloc(12); n.writeUIntBE(counter, 5, 6); n[11] = last ? 1 : 0; return n; };

export function encrypt(plaintext, recipient) {
  const pt = Buffer.from(plaintext), rcp = parseRecipient(recipient);
  const fileKey = randomBytes(16);
  const ephPriv = generateKeyPairSync('x25519').privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const ephShare = pubOfPriv(ephPriv);
  const wrapKey = hkdf(x25519(ephPriv, rcp), Buffer.concat([ephShare, rcp]), 'age-encryption.org/v1/X25519');
  const body = aead(wrapKey, Buffer.alloc(12), fileKey);
  let header = `age-encryption.org/v1\n-> X25519 ${b64(ephShare)}\n${b64(body)}\n---`;
  const mac = createHmac('sha256', hkdf(fileKey, Buffer.alloc(0), 'header')).update(header).digest();
  header += ` ${b64(mac)}\n`;
  const nonce = randomBytes(16), payloadKey = hkdf(fileKey, nonce, 'payload');
  const out = [Buffer.from(header, 'ascii'), nonce];
  const n = Math.max(1, Math.ceil(pt.length / CHUNK));
  for (let i = 0; i < n; i++) out.push(aead(payloadKey, streamNonce(i, i === n - 1), pt.subarray(i * CHUNK, (i + 1) * CHUNK)));
  return Buffer.concat(out);
}

export function decrypt(ciphertext, identity) {
  const buf = Buffer.from(ciphertext), id = bech32Decode(String(identity).trim());
  if (id.hrp !== 'age-secret-key-' || id.bytes.length !== 32) throw new Error('age: not an identity');
  const myPub = pubOfPriv(id.bytes);
  const marker = buf.indexOf('\n--- '); if (marker < 0) throw new Error('age: no header terminator');
  const macEnd = buf.indexOf('\n', marker + 1); if (macEnd < 0) throw new Error('age: truncated header');
  const headerNoMac = buf.subarray(0, marker + 4).toString('ascii');           // up to and including '---'
  const mac = unb64(buf.subarray(marker + 5, macEnd).toString('ascii'));
  const lines = headerNoMac.split('\n'); if (lines[0] !== 'age-encryption.org/v1') throw new Error('age: unsupported version');
  let fileKey = null;
  for (let i = 1; i < lines.length - 1; i++) {
    if (!lines[i].startsWith('-> ')) continue;
    const args = lines[i].slice(3).split(' '); let bodyB64 = ''; let j = i + 1;
    for (; j < lines.length - 1 && !lines[j].startsWith('-> '); j++) { bodyB64 += lines[j]; if (lines[j].length < 64) { j++; break; } }
    if (args[0] === 'X25519' && args.length === 2 && !fileKey) {
      try { const share = unb64(args[1]); if (share.length !== 32) continue; const body = unb64(bodyB64); if (body.length !== 32) continue;
        const wrapKey = hkdf(x25519(id.bytes, share), Buffer.concat([share, myPub]), 'age-encryption.org/v1/X25519');
        fileKey = unaead(wrapKey, Buffer.alloc(12), body); } catch (_) { fileKey = null; }
    }
    i = j - 1;
  }
  if (!fileKey) throw new Error('age: no matching recipient stanza for this identity');
  const want = createHmac('sha256', hkdf(fileKey, Buffer.alloc(0), 'header')).update(headerNoMac).digest();
  if (mac.length !== 32 || !timingSafeEqual(mac, want)) throw new Error('age: header MAC mismatch');
  const payload = buf.subarray(macEnd + 1); if (payload.length < 16 + 16) throw new Error('age: truncated payload');
  const payloadKey = hkdf(fileKey, payload.subarray(0, 16), 'payload'); const body = payload.subarray(16);
  const out = []; const full = CHUNK + 16; const n = Math.max(1, Math.ceil(body.length / full));
  for (let i = 0; i < n; i++) { const c = body.subarray(i * full, (i + 1) * full); const last = i === n - 1; if (!last && c.length !== full) throw new Error('age: bad chunk'); if (last && c.length === 16 && n > 1) throw new Error('age: empty final chunk'); out.push(unaead(payloadKey, streamNonce(i, last), c)); }
  return Buffer.concat(out);
}
