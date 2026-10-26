import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { zipEntryNames } from "../src/export/zip.js";
import { PNG_SIGNATURE, pngChunks } from "../src/prep/pngmeta.js";
import { BRAND, findOldBrand } from "./brand-words.mjs";
import { startFakeServer } from "./fake-server.mjs";
import { zipEntries } from "./zip-read.mjs";

// PN-01: a fake design and a paid download (IS_FAKE=1); every HTML page, script, stylesheet and API
// response, the preview images' metadata and every ZIP entry (PDF, AI, EPS, DXF, SVG, PNG, README)
// say PatternNifty and never "IS" as a brand. PatternNifty must stand in the README, the PDF
// metadata and every production sheet page's footer.

const ROOT = new URL("../", import.meta.url).pathname;
const PUBLIC = path.join(ROOT, "public");
const PHOTO = readFileSync(path.join(ROOT, "tools/fixtures/upload/photo.png"));
const SITE = "https://patternnifty.com";
const CODE_FORMAT = /^PN-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

function publicFiles(dir = PUBLIC, prefix = "") {
  return readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory()
    ? publicFiles(path.join(dir, f), `${prefix}${f}/`) : [`${prefix}${f}`]));
}

// PNG: every chunk but the pixels, as text (zTXt/iTXt/iCCP inflated where they can be).
function pngText(buf) {
  return pngChunks(buf).filter((c) => c.type !== "IDAT").map((c) => {
    let text = `${c.type} ${c.data.toString("latin1")}`;
    if (["zTXt", "iTXt", "iCCP"].includes(c.type)) {
      for (let at = c.data.indexOf(0); at >= 0 && at < c.data.length; at = c.data.indexOf(0, at + 1)) {
        try { text += inflateSync(c.data.subarray(at + 2)).toString("latin1"); break; } catch { /* next NUL */ }
      }
    }
    return text;
  }).join("\n");
}

// PDF (and AI): the document's own text (dictionaries, Info, operators; streams left out, they are
// read through pdf.js) and, per page, the text pdf.js reads, plus its metadata.
async function pdfRead(buf) {
  const raw = buf.toString("latin1").replace(/stream\r?\n[\s\S]*?endstream/g, "stream endstream");
  const doc = await getDocument({ data: new Uint8Array(buf), verbosity: 0, isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    pages.push((await (await doc.getPage(i)).getTextContent()).items.map((it) => it.str).join(" ").replace(/\s+/g, " "));
  }
  const { info } = await doc.getMetadata();
  return { raw, pages, info };
}

test("the check finds IS as a brand and nothing else", () => {
  for (const text of ["IS design PN-7K3Q-9XPA", "Made with IS · Page 1 of 2", "IS-7K3Q-9XPA", "IS · PREVIEW · PN-7K3Q-9XPA",
    "%%Creator: IS", "/Producer (IS) /Creator (IS)", "<title>IS · Image to rhinestone template</title>", '"IS is very busy"']) {
    assert.ok(findOldBrand(text).length > 0, text);
  }
  for (const text of ["THIS IS_FAKE ISO is", "PatternNifty design PN-7K3Q-9XPA", "Made with PatternNifty · Page 1 of 2", "is.code", "ISTestShop"]) {
    assert.deepEqual(findOldBrand(text), [], text);
  }
});

test("a fake design and a paid download say PatternNifty everywhere and never IS", { timeout: 120_000 }, async () => {
  const srv = await startFakeServer();
  const problems = [];
  const seen = [];
  const check = (where, text) => { for (const at of findOldBrand(text)) problems.push(`${where}: ${at}`); };

  // Every response: headers, and the body as text or, for a PNG, its metadata.
  async function call(pathname, init = {}) {
    const response = await fetch(`${srv.url}${pathname}`, init);
    const body = Buffer.from(await response.arrayBuffer());
    const where = `${init.method || "GET"} ${pathname}`;
    const type = response.headers.get("content-type") || "";
    seen.push(type);
    check(`${where} headers`, JSON.stringify([...response.headers]));
    if (body.subarray(0, 8).equals(PNG_SIGNATURE)) check(`${where} (PNG metadata)`, pngText(body));
    else if (/html|javascript|css|json|text|svg/.test(type)) check(where, body.toString("utf8"));
    return { status: response.status, headers: response.headers, body, json: () => JSON.parse(body.toString("utf8")) };
  }
  const post = (pathname, data) => call(pathname, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

  try {
    for (const f of publicFiles()) await call(`/${f}`);
    for (const p of ["/", "/download", "/privacy", "/terms", "/contact", "/api/config", "/no-such-file.js"]) await call(p);

    // Upload, a design, its views, "Use this design".
    const form = new FormData();
    form.append("consent", "1");
    form.append("image", new Blob([PHOTO], { type: "image/png" }), "photo.png");
    const { code } = (await call("/api/upload", { method: "POST", body: form })).json();
    assert.match(code, CODE_FORMAT);
    for (let i = 0; i < 100 && (await call(`/api/uploads/${code}/1`)).json().background !== "ready"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (const b of ["kept", "removed"]) assert.equal((await call(`/api/uploads/${code}/1/preview?background=${b}`)).status, 200);
    const created = (await post(`/api/attempts/${code}`, { upload: 1, mode: "colour", removeBackground: true, adjustments: {} })).json();
    await srv.pipeline.idle();
    const n = created.attempt;
    assert.equal((await call(`/api/attempts/${code}/${n}`)).json().status, "done");
    for (const p of ["", "/prepare", "/working", `/result/${n}`, "/done"]) await call(`/c/${code}${p}`);
    const tinted = await call(`/api/attempts/${code}/${n}/tinted.png`);
    assert.equal(tinted.status, 200);
    for (const p of ["original.png", "original.png?source=upload"]) assert.equal((await call(`/api/attempts/${code}/${n}/${p}`)).status, 200);
    await post(`/api/codes/${code}/select`, { attempt: n });
    await call(`/api/codes/${code}`);

    // Paid, then downloaded.
    await call(`/api/download/${code}`);
    assert.equal((await post(`/api/test/payment/${code}`, { state: "paid" })).json().state, "ready");
    await call(`/api/download/${code}`);
    const zip = await call(`/api/download/${code}/zip`);
    assert.equal(zip.status, 200);
    assert.match(zip.headers.get("content-disposition"), new RegExp(`filename="${code}\\.zip"`));

    // Every ZIP entry: its name, and its content as the buyer's software reads it.
    const { entries, comment } = zipEntries(zip.body);
    check("ZIP comment", comment);
    assert.deepEqual(entries.map((e) => e.name), zipEntryNames(code));
    const footers = [];
    for (const e of entries) {
      const where = `ZIP ${e.name}`;
      check(`${where} (name)`, e.name);
      if (e.data.subarray(0, 8).equals(PNG_SIGNATURE)) {
        check(`${where} (PNG metadata)`, pngText(e.data));
      } else if (e.data.subarray(0, 5).toString("latin1") === "%PDF-") {
        const pdf = await pdfRead(e.data);
        check(where, pdf.raw);
        pdf.pages.forEach((text, i) => check(`${where} page ${i + 1}`, text));
        check(`${where} (metadata)`, JSON.stringify(pdf.info));
        assert.deepEqual([pdf.info.Producer, pdf.info.Creator, pdf.info.Title], [BRAND, BRAND, `${BRAND} design ${code}`], where);
        if (e.name.startsWith("production-sheet")) {
          pdf.pages.forEach((text, i) => {
            assert.ok(text.includes(`Made with ${BRAND} · Page ${i + 1} of ${pdf.pages.length}`), `${where} page ${i + 1} footer`);
          });
          assert.ok(pdf.pages[0].includes(`${BRAND} design ${code}`), `${where} title`);
          footers.push(e.name);
        }
      } else {
        const text = e.data.toString("utf8");
        check(where, text);
        if (e.name.endsWith(".eps")) assert.match(text, new RegExp(`^%%Creator: ${BRAND}$`, "m"), where);
        if (e.name.endsWith(".dxf")) assert.match(text, new RegExp(`\\n\\$LASTSAVEDBY\\r?\\n\\s*1\\r?\\n${BRAND}\\r?\\n`), where);
      }
    }
    assert.deepEqual(footers, ["production-sheet-A4.pdf", "production-sheet-Letter.pdf"]);
    const readme = entries.find((e) => e.name === "README.txt").data.toString("utf8");
    assert.ok(readme.startsWith(`${BRAND} design ${code}\r\n${SITE}\r\n`), "README names PatternNifty and the site");

    assert.ok(seen.some((t) => t.includes("html")) && seen.some((t) => t.includes("javascript")) && seen.some((t) => t.includes("css")));
    assert.ok(seen.filter((t) => t.startsWith("image/png")).length >= 5, "preview images checked");
    assert.deepEqual(problems, []);
  } finally {
    await srv.stop();
  }
});
