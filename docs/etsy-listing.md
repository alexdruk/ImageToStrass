# Etsy listing — texts and settings (IS-06, expectations IS-07b, PatternNifty PN-01, texts PN-07)

The one Etsy listing of spec section 11.1 (decision D8: one listing, one price). Copy the texts below
into Etsy as they are. The buyer sees the public name PatternNifty and the site patternnifty.com,
never IS (the internal project name).

## Settings

| Setting | Value |
| --- | --- |
| Type | Digital files |
| When made | The newest year Etsy offers (not "Made to order": a Made to order listing has no file and each order must be completed by hand) |
| Digital file | `docs/PatternNifty-how-to-download.pdf` (one page: go to `patternnifty.com/download` and enter your code) |
| Price | One price, no variations (still open: spec section 19) |
| Quantity | Any; a buyer who orders several designs enters one code per design |
| Personalization | **On, required**, no add-on price |
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
See your rhinestone design before you buy. Pay only if you like it.

Upload your photo at patternnifty.com and get a finished rhinestone design in a few minutes, right in your browser. Nothing to install: it works on Mac, Windows, tablets and phones. No tracing and no editing: every stone and colour is placed for you.

Not happy with the result? Try again, up to 3 designs. You buy only when you see one you like.

Digital template only: no stones, flock sheets or physical items are shipped.
Designs are created with the help of AI tools.

HOW IT WORKS
1. Go to patternnifty.com and upload your photo (JPG, PNG, WebP and more, up to 50 MB).
2. Remove the background, crop and adjust if you like. Choose Colour or Black & white (Bold or Shaded).
3. Wait a few minutes while your design is made, usually 2 to 5. You can leave the page and come back with your code.
4. See your finished design next to your photo, with its real size and stone count.
5. Like it? You get a code, for example PN-7K3Q-9XPA.
6. Come back here, paste the code in the Personalization box and check out.
7. Go to patternnifty.com/download, enter your code and download your files.

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
- Nothing is charged until you check out here on Etsy.
- Several designs? Make each one with its own code and paste all codes in the Personalization box.
- Your files are usually ready within 10 minutes of checkout and can be downloaded for 30 days.
- Your photo and designs are deleted 30 days after your last visit, or 30 days after payment.
- You may sell items you make with your template. Please don't resell or share the files themselves.
- Only upload photos you own or have the right to use.
- This is a digital item, so there are no refunds once the files have been downloaded.

Cricut, Silhouette and LightBurn are trademarks of their owners. PatternNifty is not affiliated with them.

Questions? Send us a message on Etsy and include your PatternNifty code.
```

The address is plain text: Etsy does not make it a link. The description names no price, has no buy
button and asks for no contact details outside Etsy (Etsy's Off-Platform Transactions policy). The
AI line is the generic disclosure of Etsy's Creativity Standards; no tool or provider is named
(spec sections 1 and 12). "Deleted 30 days after your last visit, or 30 days after payment" is the
rule of spec D7 (PN-07).

## Personalization instructions

```
Make your design first at patternnifty.com, then paste its code here, e.g. PN-7K3Q-9XPA. Several designs: one code each.
```

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
