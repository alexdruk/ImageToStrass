import crypto from "node:crypto";

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function createPkcePair() {
  const verifier = randomToken(32);

  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");

  return {
    verifier,
    challenge
  };
}