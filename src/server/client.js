import crypto from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// The buyer's IP and its hash (spec sections 4.1 and 13). The server listens on 127.0.0.1 only,
// so every request comes from cloudflared on this Mac (or a local tool) and CF-Connecting-IP
// can be trusted when the peer is loopback.

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function clientIp(req) {
  const peer = req.socket.remoteAddress;
  const forwarded = req.get("cf-connecting-ip");

  return LOOPBACK.has(peer) && forwarded ? forwarded.trim() : peer;
}

// HMAC key made once per install and kept in data/, so stored hashes cannot be reversed by
// trying every IPv4 address.
export function loadIpKey(file) {
  try {
    return readFileSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  mkdirSync(path.dirname(file), { recursive: true });
  const key = crypto.randomBytes(32);

  try {
    writeFileSync(file, key, { flag: "wx", mode: 0o600 });
    return key;
  } catch (error) {
    if (error.code === "EEXIST") {
      return readFileSync(file);
    }

    throw error;
  }
}

export function ipHasher(key) {
  return (ip) => crypto.createHmac("sha256", key).update(String(ip)).digest("hex").slice(0, 32);
}

// The hasher for the key in file, loading (or making) the key on first use.
export function fileIpHasher(file) {
  let hash = null;
  return (ip) => (hash ??= ipHasher(loadIpKey(file)))(ip);
}
