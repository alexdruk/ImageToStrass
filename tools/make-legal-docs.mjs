// Writes docs/legal/privacy.md, terms.md, contact.md and legal.md from public/legal.js (PN-07), the
// texts the web app shows, with each detail from .env shown as its variable name, for review on
// GitHub. tools/test-legal.mjs checks the committed files are what this writes.
//   node tools/make-legal-docs.mjs
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PAGES, renderMarkdown } from "../public/legal.js";

export const LEGAL_DOCS = new URL("../docs/legal/", import.meta.url);

const HEADER = "<!-- Made by tools/make-legal-docs.mjs from public/legal.js: change the texts there, then run it again. -->\n\n";

const FOOTER = "\n---\n\n`IS_…` names are settings in `.env`: the site shows their values, or \"Not set\" when one is empty.\n";

// name -> the Markdown file's text.
export function legalDocs() {
  return Object.fromEntries(Object.entries(PAGES).map(([name, page]) => [name, HEADER + renderMarkdown(page) + FOOTER]));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [name, text] of Object.entries(legalDocs())) {
    writeFileSync(new URL(`${name}.md`, LEGAL_DOCS), text);
    console.log(`docs/legal/${name}.md`);
  }
}
