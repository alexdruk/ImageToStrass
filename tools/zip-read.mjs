import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";

// A ZIP's entries (name, comment, extra fields, content) and its archive comment, read from the
// central directory. For the checks of the files the buyer downloads.
export function zipEntries(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "ZIP end record");
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50, "ZIP central header");
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    const extra = buf.subarray(at + 46 + nameLen, at + 46 + nameLen + extraLen);
    const comment = buf.toString("utf8", at + 46 + nameLen + extraLen, at + 46 + nameLen + extraLen + commentLen);
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + size);
    entries.push({ name, extra, comment, data: method === 8 ? inflateRawSync(raw) : raw, localExtra: buf.subarray(local + 30 + buf.readUInt16LE(local + 26), dataAt) });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, comment: buf.toString("utf8", eocd + 22, eocd + 22 + buf.readUInt16LE(eocd + 20)) };
}
