import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { LAST_UPDATED, NOT_SET, PAGES, lastUpdatedText, renderHtml } from "../public/legal.js";
import { LEGAL_KEYS, loadConfig, missingLegal } from "../src/server/config.js";
import { findOldBrand } from "./brand-words.mjs";
import { legalDocs, LEGAL_DOCS } from "./make-legal-docs.mjs";

// PN-07: the privacy policy, terms, contact and legal notice (public/legal.js), the seller's details
// from .env, and their review copies in docs/legal/. The pages in the browser, at 390 px too, are
// checked by tools/webapp-flow.mjs; the provider words by tools/test-no-provider-leak.mjs.

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Made-up details: the real ones live only in .env.
const SET = { name: "Example Seller", address: "1 Example Road", registration: "REG 123", country: "Exampleland", law: "the State of Example", email: "help@example.invalid", listing: "https://www.etsy.com/listing/1" };
const text = (html) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const page = (name, values = SET) => text(renderHtml(PAGES[name], values, esc));

test("docs/legal/*.md are the texts of public/legal.js", () => {
  for (const [name, md] of Object.entries(legalDocs())) {
    assert.equal(readFileSync(new URL(`${name}.md`, LEGAL_DOCS), "utf8"), md, `docs/legal/${name}.md: run node tools/make-legal-docs.mjs`);
    // Each detail from .env is shown as its variable name, never a value.
    for (const value of Object.values(SET)) assert.ok(!md.includes(value), value);
  }
  assert.match(legalDocs().privacy, /`IS_LEGAL_NAME`, `IS_LEGAL_ADDRESS`\. Email: `IS_CONTACT_EMAIL`/);
});

test("every page has its title, Last updated and no old brand", () => {
  assert.deepEqual(Object.keys(PAGES), ["privacy", "terms", "contact", "legal"]);
  assert.match(LAST_UPDATED, /^\d{4}-\d{2}-\d{2}$/);
  for (const name of Object.keys(PAGES)) {
    const t = page(name);
    assert.ok(t.startsWith(PAGES[name].title), name);
    assert.ok(t.includes(`Last updated: ${lastUpdatedText()}`), name);
    assert.deepEqual(findOldBrand(t), [], name);
  }
});

test("empty details show Not set; an empty registration number hides its line", () => {
  const empty = page("legal", {});
  for (const label of ["Name", "Address", "Country", "Email"]) assert.ok(empty.includes(`${label}: ${NOT_SET}`), label);
  assert.ok(!empty.includes("Registration"));
  assert.ok(page("legal").includes("Registration number: REG 123"));
  assert.ok(page("privacy", {}).includes(`PatternNifty is run by ${NOT_SET}, ${NOT_SET}. Email: ${NOT_SET}.`));
  assert.ok(page("terms", {}).includes(`governed by the law of ${NOT_SET}`));
  // The email is a mailto link; the listing link is plain words without IS_ETSY_LISTING_URL.
  assert.match(renderHtml(PAGES.contact, SET, esc), /<a href="mailto:help@example\.invalid">help@example\.invalid<\/a>/);
  assert.match(renderHtml(PAGES.contact, SET, esc), /<a href="https:\/\/www\.etsy\.com\/listing\/1" target="_blank" rel="noopener">the PatternNifty listing<\/a>/);
  assert.ok(!renderHtml(PAGES.contact, { ...SET, listing: "" }, esc).includes("etsy.com"));
  // Values are escaped.
  assert.ok(renderHtml(PAGES.legal, { ...SET, name: "<b>x</b>" }, esc).includes("&lt;b&gt;x&lt;/b&gt;"));
});

test("privacy: the required parts, in order, and the browser storage found in the code", () => {
  const t = page("privacy");
  const order = ["Who is responsible", "What we collect", "Why we use it", "Who else receives data", "Your photos",
    "How long we keep it", "Cookies and browser storage", "Your rights"];
  const at = order.map((h) => t.indexOf(h));
  assert.ok(at.every((i, k) => i > 0 && (k === 0 || i > at[k - 1])), JSON.stringify(at));
  for (const words of ["Example Seller, 1 Example Road. Email: help@example.invalid", "24 hours", "30 days in server logs",
    "order and transaction numbers", "no accounts", "contract", "legitimate interest", "An AI image service in the United States",
    "Cloudflare", "Etsy", "standard data-protection terms", "never uses them to train AI", "no cookies",
    // What the AI image service keeps (its API data terms, checked in the PN-07 follow-up).
    "for up to 30 days to check for abuse, and does not use them to train AI", "The AI image service: up to 30 days, only to check for abuse, never to train AI.",
    "data-protection authority", "within one month"]) assert.ok(t.includes(words), words);
  // Exactly what the app and Turnstile store (public/app.js; Turnstile checked in a browser, PN-07).
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /const CODE_KEY = "is\.code";/);
  assert.match(app, /sessionStorage\.setItem\(`is\.working\.\$\{session\.code\}`/);
  assert.equal([...app.matchAll(/(localStorage|sessionStorage)\.setItem\(/g)].length, 2, "the privacy policy names every item the app stores");
  assert.doesNotMatch(app, /document\.cookie|indexedDB/);
  for (const words of ["is.code in local storage", "is.working.<your code> in session storage", "cf.turnstile.u"]) assert.ok(t.includes(words), words);
  // Markdown shows < and > as they are (in code, so GitHub keeps them).
  assert.ok(legalDocs().privacy.includes("`is.working.<your code>`"));
  for (const md of Object.values(legalDocs())) assert.doesNotMatch(md, /&lt;|&gt;|&amp;/);
});

test("terms: the expectations line word for word, the withdrawal rule, licence and law", () => {
  const t = page("terms");
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  // The app's line with its designsPerCode of 3.
  const line = app.match(/const expectation = \(\) => `([^`]+)`/)[1].replace("${config.designsPerCode}", "3");
  assert.ok(t.includes(line));
  for (const words of ["sold by Example Seller", "up to 3 designs", "only for the design you pick", "for 30 days",
    "no stones", "right to use it", "may decline", "sell the items you make", "may not resell, share",
    "delivery starts now", "14-day right to withdraw", "refund through Etsy", "with the help of AI tools",
    "test your template", "law of the State of Example", "country where you live"]) assert.ok(t.includes(words), words);
  assert.match(renderHtml(PAGES.terms, SET, esc), /<a href="\/legal" data-link>legal notice<\/a>/);
});

test("contact and legal notice: Etsy for orders, email for privacy, no form; Cloudflare as network", () => {
  const c = renderHtml(PAGES.contact, SET, esc);
  assert.doesNotMatch(c, /<form|<input|<textarea/);
  assert.ok(text(c).includes("Message seller") && text(c).includes("PatternNifty code"));
  const l = page("legal");
  for (const words of ["Example Seller", "1 Example Road", "Exampleland", "help@example.invalid", "seller's own server",
    "Cloudflare, Inc., 101 Townsend St, San Francisco, CA 94107, USA"]) assert.ok(l.includes(words), words);
});

test("config: the legal details from .env, the required ones missing when empty", () => {
  assert.deepEqual(Object.values(LEGAL_KEYS), ["IS_LEGAL_NAME", "IS_LEGAL_ADDRESS", "IS_LEGAL_REGISTRATION", "IS_LEGAL_COUNTRY", "IS_LEGAL_LAW", "IS_CONTACT_EMAIL"]);
  assert.deepEqual(missingLegal({}), ["IS_LEGAL_NAME", "IS_LEGAL_ADDRESS", "IS_LEGAL_COUNTRY", "IS_LEGAL_LAW", "IS_CONTACT_EMAIL"]);
  assert.deepEqual(loadConfig({ IS_LEGAL_NAME: " Seller " }).legal.name, "Seller");
  const env = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  for (const key of [...Object.values(LEGAL_KEYS), "IS_KEEP_UNPAID_DAYS", "IS_KEEP_PAID_DAYS"]) assert.match(env, new RegExp(`^${key}=`, "m"), key);
  for (const key of Object.values(LEGAL_KEYS)) assert.match(env, new RegExp(`^${key}=\\s*(#.*)?$`, "m"), `${key} is empty in .env.example`);
  assert.deepEqual([loadConfig({}).keepUnpaidDays, loadConfig({}).keepPaidDays], [30, 30]);
});
