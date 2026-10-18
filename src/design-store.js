import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DESIGNS_DIR = path.resolve(MODULE_DIR, "../data/designs");

async function ensureDirectory() {
  await mkdir(DESIGNS_DIR, { recursive: true });
}

function isValidDesignId(designId) {
  return typeof designId === "string" &&
    /^RS-[A-F0-9]{32}$/.test(designId);
}

export async function createDesign({ language, letters, frameId }) {
  await ensureDirectory();

  // Each design has its own file. The exclusive create flag prevents
  // an existing design from being overwritten.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const designId =
      `RS-${randomUUID().replaceAll("-", "").toUpperCase()}`;

    const design = {
      designId,
      language,
      letters,
      frameId,
      createdAt: new Date().toISOString(),
      status: "accepted"
    };

    const filePath = path.join(DESIGNS_DIR, `${designId}.json`);

    try {
      await writeFile(filePath, JSON.stringify(design, null, 2), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });

      return design;
    } catch (error) {
      if (error.code !== "EEXIST" || attempt === 2) {
        throw error;
      }
    }
  }

  throw new Error("Unable to allocate a unique Design ID.");
}

export async function getDesign(designId) {
  if (!isValidDesignId(designId)) {
    return null;
  }

  try {
    const contents = await readFile(
      path.join(DESIGNS_DIR, `${designId}.json`),
      "utf8"
    );

    return JSON.parse(contents);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}
