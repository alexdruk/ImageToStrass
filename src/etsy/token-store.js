import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const TOKEN_FILE = path.resolve("data/etsy-tokens.enc");

function getKey() {
  const value = process.env.TOKEN_ENCRYPTION_KEY;

  if (!value) {
    throw new Error("TOKEN_ENCRYPTION_KEY is not configured.");
  }

  const key = Buffer.from(value, "base64");

  if (key.length !== 32) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes."
    );
  }

  return key;
}

export async function saveTokens(tokens) {
  const key = getKey();
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const plaintext = JSON.stringify(tokens);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  const payload = {
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    data: encrypted.toString("base64")
  };

  await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });

  await fs.writeFile(
    TOKEN_FILE,
    JSON.stringify(payload, null, 2),
    "utf8"
  );
}

export async function loadTokens() {
  const key = getKey();

  let payload;

  try {
    payload = JSON.parse(
      await fs.readFile(TOKEN_FILE, "utf8")
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(payload.iv, "base64")
  );

  decipher.setAuthTag(
    Buffer.from(payload.authTag, "base64")
  );

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final()
  ]);

  return JSON.parse(decrypted.toString("utf8"));
}