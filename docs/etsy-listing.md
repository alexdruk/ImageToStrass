# Etsy listing — texts and settings (IS-06, expectations IS-07b, PatternNifty PN-01, texts PN-07, buy first PN-08)

The one Etsy listing of spec section 11.1 (decision D8: one listing, one price). Copy the texts below
into Etsy as they are. The buyer sees the public name PatternNifty and the site patternnifty.com,
never IS (the internal project name).

## Settings

| Setting | Value |
| --- | --- |
| Type | Digital files |
| When made | The newest year Etsy offers (not "Made to order": a Made to order listing has no file and each order must be completed by hand) |
| Digital file | `docs/PatternNifty-how-to-download.pdf` (one page, two parts: made your design first, go to `patternnifty.com/download` and enter your code; no design yet, go to `patternnifty.com/order` and enter your Etsy order number) |
| Price | One price, no variations (still open: spec section 19) |
| Quantity | Any; a buyer who orders several designs enters one code per design, or leaves the field empty and gets one code per unit on `patternnifty.com/order` (PN-08) |
| Personalization | **On, required: No** (optional, PN-08: a buyer may check out first and make the design after), no add-on price |
| Personalization field title | Exactly `Personalization` (the poller reads that field first, spec 11.3) |
| Personalization instructions | See below |
| Personalization character limit | 100 (room for two or three codes) |
| Photos | `docs/listing/` (PN-04b) |

After publishing:

1. Put the listing id in `.env` as `IS_ETSY_LISTING_IDS=<id>` and its URL as
   `IS_ETSY_LISTING_URL=https://www.etsy.com/listing/<id>`, then restart the server. The poller
   stores only transactions of the listings in `IS_ETSY_LISTING_IDS`. The contact page links to the
   listing through `IS_ETSY_LISTING_URL`.
2. Attach `docs/PatternNifty-how-to-download.pdf`. To make it again:
   `node tools/make-how-to-pdf.mjs https://patternnifty.com` (writes that file).

## Title

```
Photo to Rhinestone Template, See Your Design Before You Buy, No Software to Install, Pet Portrait or Logo, SVG DXF PDF
```

(119 characters; Etsy allows 140.)

## Description

```
See your rhinestone design before you buy, or buy first and make it after checkout.

Upload your photo at patternnifty.com and get a finished rhinestone design in a few minutes, right in your browser. Nothing to install: it works on Mac, Windows, tablets and phones. No tracing and no editing: every stone and colour is placed for you. Try up to 3 designs and keep the one you like.

Digital template only: no stones, flock sheets or physical items are shipped.
Designs are created with the help of AI tools.

HOW IT WORKS
Option 1, design first (pay only if you like it):
1. Go to patternnifty.com, upload your photo and wait a few minutes (usually 2 to 5).
2. Like your design? Copy its code, for example PN-7K3Q-9XPA.
3. Paste the code in the Personalization box here and check out.
4. Go to patternnifty.com/download, enter your code and download your files.

Option 2, buy first:
1. Check out here and leave the Personalization box empty.
2. Go to patternnifty.com/order and enter your Etsy order number.
3. Upload your photo, try up to 3 designs, pick one and download your files.
Not happy with any of your 3 designs? Send us a message and we will refund you.

WHAT TO EXPECT
Your design is an artistic rhinestone version of your photo, not a copy of it: faces are stylised rather than photographic. Colour designs use real rhinestone colours chosen from your photo. Black & white comes in two styles: Bold (strong, graphic) and Shaded (more detail).

WHAT YOU GET (one ZIP)
- SVG at true size, grouped by stone colour and size
- Production sheet PDF in A4 (mm) and Letter (inches), with stone counts per size and colour
- DXF, AI and EPS for cutting and design software
- PNG at 300 dpi and a colour preview of the finished design
- SVG and DXF open in Cricut Design Space, Silhouette Studio and LightBurn (Silhouette needs Designer Edition or higher for SVG; DXF works in all editions)

SIZE AND STONES
Each design has its own natural size, usually 13 to 30 cm (5 to 12 in) on the longest side. Stones are mostly SS6, with some SS4, SS10 and SS16; eye pupils may be SS20. You see the exact size before you buy.

GOOD TO KNOW
- Design first? Nothing is charged until you check out here on Etsy.
- Several designs? Make each one with its own code and paste all codes in the Personalization box, or buy several and get one code per design at patternnifty.com/order.
- Your files are usually ready within 10 minutes of checkout and can be downloaded for 30 days.
- Your photo and designs are deleted 30 days after your last visit, or when your 30-day download ends.
- You may sell items you make with your template. Please don't resell or share the files themselves.
- Only upload photos you own or have the right to use.
- This is a digital item, so there are no refunds once the files have been downloaded.

Cricut, Silhouette and LightBurn are trademarks of their owners. PatternNifty is not affiliated with them.

Questions? Send us a message on Etsy and include your PatternNifty code.
```

The address is plain text: Etsy does not make it a link. The description names no price, has no buy
button and asks for no contact details outside Etsy (Etsy's Off-Platform Transactions policy). The
AI line is the generic disclosure of Etsy's Creativity Standards; no tool or provider is named
(spec sections 1 and 12). "Deleted 30 days after your last visit, or when your 30-day download ends"
is the rule of spec D7 (PN-07; PN-08: a buy-first design's download starts when it is picked). The two
options of HOW IT WORKS are spec section 1 (PN-08); option 2's refund is by Etsy message, as every
refund.

## Personalization instructions

```
Made a design at patternnifty.com? Paste its code. No code yet? Leave empty and make your design after checkout.
```

(112 characters; Etsy allows 120 for the instructions.) An empty field is the buy-first path (PN-08):
the buyer enters the Etsy order number at `patternnifty.com/order` and gets one code per unit bought.

PatternNifty reads every code in the field (spaces, dashes, lower case, O for 0 and I or L for 1 are
all fine), so a buyer who orders two designs can enter both codes. If the field ever reaches the
poller under another name or property id, it also reads codes from every other field of the order
(spec 11.3). Codes made before the rebrand (IS-XXXX-XXXX) are no longer read.

## Tags (13 at most, 20 characters each)

```
photo to rhinestone, rhinestone template, rhinestone svg, custom rhinestone, pet rhinestone,
rhinestone portrait, rhinestone design, rhinestone pattern, bling shirt design, hotfix template,
rhinestone dxf, custom bling shirt, no software needed
```
