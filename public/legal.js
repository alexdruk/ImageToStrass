// The privacy policy, terms, contact and legal notice pages (PN-07): one source for the web app's
// pages (renderHtml) and for docs/legal/*.md (renderMarkdown, tools/make-legal-docs.mjs), so the
// two never differ. Plain English. The AI image service is never named (spec section 12).
//
// A page is a title, a lede and blocks: ["h2", text], ["p", text], ["ul", [text, ...]]. A block with
// a third item { if: field } is shown only when that field is set. In a text, {field} is one of the
// seller's details from .env (LEGAL_FIELDS; "Not set" when empty), [words](href) is a link (a link
// to {listing} is plain words when IS_ETSY_LISTING_URL is not set) and `words` is a name the
// browser stores, shown as code.

export const LAST_UPDATED = "2026-10-30";

// field -> the .env key it comes from (src/server/config.js LEGAL_KEYS, plus the listing URL).
export const LEGAL_FIELDS = {
  name: "IS_LEGAL_NAME",
  address: "IS_LEGAL_ADDRESS",
  registration: "IS_LEGAL_REGISTRATION",
  country: "IS_LEGAL_COUNTRY",
  law: "IS_LEGAL_LAW",
  email: "IS_CONTACT_EMAIL",
  listing: "IS_ETSY_LISTING_URL"
};

export const NOT_SET = "Not set";

// The expectations line of spec section 10, word for word.
const EXPECTATIONS = "Your design is an artistic rhinestone version of your photo; faces are stylised, not photographic. You can try up to 3 designs and only buy if you like one.";

export const PAGES = {
  privacy: {
    title: "Privacy policy",
    lede: "How PatternNifty handles your photo, your designs and your order. In short: your photo is used only to make your design, we never ask for your name or email, and your photo and designs are deleted after 30 days.",
    blocks: [
      ["h2", "Who is responsible"],
      ["p", "PatternNifty is run by {name}, {address}. Email: {email}."],
      ["p", "Our server is in France, so we follow the EU General Data Protection Regulation (GDPR)."],

      ["h2", "What we collect"],
      ["ul", [
        "The image you upload, and the prepared image made from it (with the background removed, cropped and adjusted as you chose).",
        "The designs made from it: the stone layouts, their previews and the files you download.",
        "Your PatternNifty code and its settings: Colour or Black & white, your adjustments, the dates and how many designs you made.",
        "Your IP address, to limit abuse and keep the service secure. The limit counters keep it in scrambled (hashed) form for 24 hours; our server logs may keep it for up to 30 days.",
        "The Etsy order details we need to match your payment: the order and transaction numbers, and the code you typed in the Personalization field.",
        "If you bought first: the Etsy order number you enter on our order page, to find your order and give you your codes."
      ]],
      ["p", "PatternNifty has no accounts and never asks for your name, email or address. You pay on Etsy; we never see your payment details."],

      ["h2", "Why we use it, and on what legal basis"],
      ["ul", [
        "To make your design and deliver your files. Legal basis: our contract with you.",
        "To protect the service from abuse and keep it secure (limits per IP address, the anti-bot check, logs). Legal basis: our legitimate interest in running a safe service."
      ]],

      ["h2", "Who else receives data"],
      ["ul", [
        "An AI image service in the United States, which turns your prepared image into the design. It receives the image only: never your code, your IP address or your order details. It may keep the image, and the picture it makes from it, for up to 30 days to check for abuse, and does not use them to train AI.",
        "Cloudflare, which carries the traffic to our server and runs the anti-bot check.",
        "Etsy, where you pay and where your order is handled. Etsy's own privacy policy applies there."
      ]],
      ["p", "Everything else, background removal included, runs on our own server. Transfers outside the EU rely on the providers' standard data-protection terms. We never sell your data."],

      ["h2", "Your photos"],
      ["ul", [
        "Please upload only images you have the right to use.",
        "Your photos are used only to make your design. They are never shown to anyone else, and PatternNifty never uses them to train AI."
      ]],

      ["h2", "How long we keep it"],
      ["ul", [
        "If you don't buy: your images, designs and files are deleted 30 days after the last time you used your code.",
        "If you buy: they are deleted 30 days after payment, the same day your download ends.",
        "If you bought first: they are kept until you pick a design, then deleted the day your 30-day download ends.",
        "After that we keep only a short record of the code (its status, dates and number of designs) and the Etsy order numbers, without any images, for our accounts.",
        "Your IP address: 24 hours in the limit counters, up to 30 days in server logs.",
        "The AI image service: up to 30 days, only to check for abuse, never to train AI.",
        "Backup copies of our database, which hold the records above, are kept for 30 days."
      ]],

      ["h2", "Cookies and browser storage"],
      ["p", "PatternNifty sets no cookies and uses no tracking or advertising. Your browser stores only:"],
      ["ul", [
        "your code, under the name `is.code` in local storage, so you can come back to your design;",
        "while a design is being made, its number, under the name `is.working.<your code>` in session storage, which your browser clears when you close the tab;",
        "for the anti-bot check (Cloudflare Turnstile), one item named `cf.turnstile.u` in the local storage of challenges.cloudflare.com. Turnstile sets no cookies on PatternNifty."
      ]],
      ["p", "These are needed for the service to work. You can clear them in your browser at any time; you then need your code to come back to your design."],

      ["h2", "Your rights"],
      ["p", "You can ask to see the data we hold about you, to correct it or delete it, and you can object to how we use it."],
      ["p", "To ask, email {email} and include your PatternNifty code. We need the code to find your data, because we don't know who you are. We answer within one month."],
      ["p", "If you live in the EU or the UK, you can also complain to your data-protection authority."]
    ]
  },

  terms: {
    title: "Terms of sale",
    lede: "The rules for using PatternNifty and buying a design. Please read them before you buy.",
    blocks: [
      ["h2", "Who sells"],
      ["p", "PatternNifty is sold by {name}. The full details are in the [legal notice](/legal)."],

      ["h2", "What you buy"],
      ["p", "A digital rhinestone template made from your image: files to download (SVG, production sheet PDF, AI, EPS, DXF and PNG). No physical item and no stones are sent."],

      ["h2", "How it works"],
      ["ul", [
        "You make up to 3 designs with one code, for free.",
        "You pay on Etsy, only for the design you pick.",
        "After payment you can download your files for 30 days."
      ]],
      ["p", "Or buy first: check out on Etsy with the Personalization field empty, then enter your Etsy order number at patternnifty.com/order. You get one code for each design you bought."],
      ["ul", [
        "With each code you make up to 3 designs and pick one; your 30-day download starts when you pick.",
        "If you don't pick a design within 30 days of payment, we deliver your latest one.",
        "If you don't like any of your 3 designs, send us a message on Etsy and we will refund you."
      ]],

      ["h2", "What to expect"],
      ["p", EXPECTATIONS],

      ["h2", "Your image"],
      ["ul", [
        "By uploading an image you confirm that you own it or have the right to use it, and that it shows nothing illegal.",
        "PatternNifty may decline an image."
      ]],

      ["h2", "What you may do with your files"],
      ["ul", [
        "You may use your template, and sell the items you make with it.",
        "You may not resell, share or give away the files themselves."
      ]],

      ["h2", "Downloads and refunds"],
      ["ul", [
        "Before you download your files, you can ask for a refund through Etsy.",
        "To download, you tick a box on the download page. By doing so you agree that delivery starts now and, where the law gives you a 14-day right to withdraw from the purchase (for example in the EU and the UK), that you lose it for this digital content.",
        "If your files don't work, send us a message on Etsy and we will put it right."
      ]],

      ["h2", "AI"],
      ["p", "Designs are created with the help of AI tools."],

      ["h2", "Liability"],
      ["p", "We make every design with care, but we can't promise it suits every material, machine or project. Please test your template on a small piece before a large job. Our liability is limited as far as the law allows."],

      ["h2", "Governing law"],
      ["p", "These terms are governed by the law of {law}. If you are a consumer, you also keep the protection of the law of the country where you live."]
    ]
  },

  contact: {
    title: "Contact",
    lede: "How to reach PatternNifty.",
    blocks: [
      ["h2", "Questions about an order or a design"],
      ["p", "Send us a message on Etsy: open [the PatternNifty listing]({listing}) and use Message seller. Please include your PatternNifty code (PN-XXXX-XXXX)."],

      ["h2", "Privacy requests"],
      ["p", "To see, correct or delete your data, email {email} with your code. See the [privacy policy](/privacy)."],

      ["p", "PatternNifty has no contact form: order questions go through Etsy, so they stay with your order."]
    ]
  },

  legal: {
    title: "Legal notice",
    lede: "Who runs PatternNifty and where it is hosted.",
    blocks: [
      ["h2", "Seller"],
      ["ul", [
        "Name: {name}",
        "Address: {address}",
        "Country: {country}",
        "Email: {email}"
      ]],
      ["p", "Registration number: {registration}", { if: "registration" }],

      ["h2", "Hosting"],
      ["p", "PatternNifty runs on the seller's own server. Network: Cloudflare, Inc., 101 Townsend St, San Francisco, CA 94107, USA."],
      ["p", "Payment and orders are handled by Etsy. See also the [terms of sale](/terms) and the [privacy policy](/privacy)."]
    ]
  }
};

const TOKEN = /\[([^\]]+)\]\(([^)]+)\)|\{(\w+)\}|`([^`]+)`/g;

// "29 October 2026".
export function lastUpdatedText(iso = LAST_UPDATED) {
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${d} ${months[m - 1]} ${y}`;
}

// Turns a text into output: each plain stretch through plain(), each {field} through field(name),
// each link through link(words, href), each `name` through code(name).
function inline(text, { plain, field, link, code }) {
  let out = "";
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    out += plain(text.slice(at, m.index));
    out += m[4] ? code(m[4]) : m[3] ? field(m[3]) : link(m[1], m[2]);
    at = m.index + m[0].length;
  }
  return out + plain(text.slice(at));
}

const shown = (block, set) => !block[2]?.if || set(block[2].if);

// The page as HTML for the web app. values: field -> text ("" when not set). Every text is escaped.
export function renderHtml(page, values, esc) {
  const value = (name) => String(values[name] ?? "").trim();
  const field = (name) => {
    const v = value(name);
    if (!v) return `<em class="not-set">${NOT_SET}</em>`;
    return name === "email" ? `<a href="mailto:${esc(v)}">${esc(v)}</a>` : esc(v);
  };
  const link = (words, href) => {
    if (href === "{listing}") {
      return value("listing") ? `<a href="${esc(value("listing"))}" target="_blank" rel="noopener">${esc(words)}</a>` : esc(words);
    }
    return href.startsWith("/") ? `<a href="${esc(href)}" data-link>${esc(words)}</a>` : `<a href="${esc(href)}">${esc(words)}</a>`;
  };
  const text = (t) => inline(t, { plain: esc, field, link, code: (c) => `<code>${esc(c)}</code>` });
  const body = page.blocks.filter((b) => shown(b, value)).map(([kind, content]) => (kind === "ul"
    ? `<ul>${content.map((li) => `<li>${text(li)}</li>`).join("")}</ul>`
    : `<${kind}>${text(content)}</${kind}>`)).join("\n");
  return `<h1>${esc(page.title)}</h1>
<p class="lede">${esc(page.lede)}</p>
<p class="sub updated">Last updated: ${lastUpdatedText()}</p>
${body}`;
}

// The page as Markdown for review on GitHub: each detail from .env shown as its variable name.
export function renderMarkdown(page) {
  const field = (name) => `\`${LEGAL_FIELDS[name]}\``;
  const link = (words, href) => {
    if (href === "{listing}") return `[${words}](${LEGAL_FIELDS.listing}) (plain words when ${LEGAL_FIELDS.listing} is not set)`;
    return href.startsWith("/") ? `[${words}](${href.slice(1)}.md)` : `[${words}](${href})`;
  };
  const text = (t) => inline(t, { plain: (s) => s, field, link, code: (c) => `\`${c}\`` });
  const body = page.blocks.map((block) => {
    const [kind, content] = block;
    const note = block[2]?.if ? ` (shown only when ${LEGAL_FIELDS[block[2].if]} is set)` : "";
    if (kind === "h2") return `## ${text(content)}`;
    if (kind === "ul") return content.map((li) => `- ${text(li)}`).join("\n");
    return `${text(content)}${note}`;
  }).join("\n\n");
  return `# ${page.title}

${page.lede}

Last updated: ${lastUpdatedText()}

${body}
`;
}
