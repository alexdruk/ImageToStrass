import { constants, copyFileSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// data/archive/<code>/ (spec section 4.2). Kept forever: nothing here ever deletes. Folders
// uploads/<k>/ and attempt-<n>/ are created exclusively and files in them are written with
// "wx", so nothing is overwritten. code.json is the one file replaced on each change.

export function codeDir(root, code) {
  return path.join(root, code);
}

export function uploadDir(root, code, k) {
  return path.join(root, code, "uploads", String(k));
}

export function attemptDir(root, code, n) {
  return path.join(root, code, `attempt-${n}`);
}

function writeNew(file, data) {
  writeFileSync(file, data, { flag: "wx" });
}

// Atomic replace of code.json with the current code row.
export function writeCodeJson(root, row) {
  const dir = codeDir(root, row.code);
  const tmp = path.join(dir, `.code.json.${process.pid}.tmp`);

  mkdirSync(dir, { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(row, null, 2)}\n`);
  renameSync(tmp, path.join(dir, "code.json"));
}

// Allocates the next upload number k (1, 2, 3, ... never reused) and creates its folder.
export function createUploadDir(root, code) {
  const parent = path.join(codeDir(root, code), "uploads");
  mkdirSync(parent, { recursive: true });

  const used = readdirSync(parent).map(Number).filter(Number.isInteger);
  let k = used.length ? Math.max(...used) + 1 : 1;

  for (;;) {
    try {
      mkdirSync(path.join(parent, String(k)));
      return { k, dir: path.join(parent, String(k)) };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      k += 1;
    }
  }
}

// Moves the received upload (a temp file under data/) into uploads/<k>/original.<ext>.
export function storeOriginal(dir, ext, tempFile) {
  const target = path.join(dir, `original.${ext}`);
  copyFileSync(tempFile, target, constants.COPYFILE_EXCL);
  return target;
}

export function storeNew(dir, name, data) {
  const file = path.join(dir, name);
  writeNew(file, data);
  return file;
}

// For "Create design" (IS-03): attempt-<n>/ with the upload's original, prepared.png and
// settings.json. Fails if attempt-<n>/ already exists.
export function writeAttemptInputs(root, code, n, { originalFile, preparedPng, settings }) {
  const dir = attemptDir(root, code, n);

  mkdirSync(path.dirname(dir), { recursive: true });
  mkdirSync(dir);
  copyFileSync(originalFile, path.join(dir, path.basename(originalFile)), constants.COPYFILE_EXCL);
  writeNew(path.join(dir, "prepared.png"), preparedPng);
  writeNew(path.join(dir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);

  return dir;
}
