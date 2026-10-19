import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// IS-XXXX-XXXX.eps (spec section 9): Ghostscript's eps2write from the .ai PDF. The DSC header lines
// that would name the converter or the temporary file (%%Creator, %%Title, %%Invocation) are
// rewritten to name IS and the design only (section 12).

const run = promisify(execFile);
const GS_CANDIDATES = ["/opt/homebrew/bin/gs", "/usr/local/bin/gs"];

// GS_PATH, else Homebrew's gs (launchd agents do not get Homebrew's PATH), else gs on the PATH.
export function ghostscriptPath(env = process.env) {
  return env.GS_PATH || GS_CANDIDATES.find((file) => existsSync(file)) || "gs";
}

function cleanHeader(eps, title) {
  const text = eps.toString("latin1");
  const end = text.indexOf("%%EndComments");
  if (end < 0) throw new Error("EPS without %%EndComments.");
  const head = [];
  let dropping = false;
  for (const line of text.slice(0, end).split("\n")) {
    // %%Invocation and its %%+ continuation lines carry the command line: left out.
    dropping = line.startsWith("%%Invocation") || (dropping && line.startsWith("%%+"));
    if (dropping) continue;
    if (line.startsWith("%%Creator:")) head.push("%%Creator: IS");
    else if (line.startsWith("%%Title:")) head.push(`%%Title: ${title}`);
    else head.push(line);
  }
  return Buffer.from(head.join("\n") + text.slice(end), "latin1");
}

// .ai (PDF) bytes -> EPS bytes.
export async function designEps(aiPdf, { title = "IS design", gs = ghostscriptPath() } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "is-eps-"));
  try {
    const input = path.join(dir, "design.pdf");
    const output = path.join(dir, "design.eps");
    writeFileSync(input, aiPdf);
    await run(gs, ["-q", "-dSAFER", "-dNOPAUSE", "-dBATCH", "-sDEVICE=eps2write", `-sOutputFile=${output}`, input], { timeout: 120000 });
    return cleanHeader(readFileSync(output), title);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
