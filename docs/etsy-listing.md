# Etsy listing — texts and settings (IS-06)

The one Etsy listing of spec section 11.1 (decision D8: one listing, one price). Copy the texts below
into Etsy as they are. `[IS address]` stands for the IS domain, which does not exist yet (spec
section 19); replace it everywhere, and make the attached PDF again with it (below), before the
listing goes live.

## Settings

| Setting | Value |
| --- | --- |
| Type | Digital files (instant download) |
| Digital file | `docs/IS-how-to-download.pdf` (one page: go to `[IS address]/download` and enter your code) |
| Price | One price, no variations (still open: spec section 19) |
| Quantity | Any; a buyer who orders several designs enters one code per design |
| Personalization | **On, required** |
| Personalization instructions | `Enter your IS code, for example IS-7K3Q-9XPA` |
| Personalization character limit | 100 (room for two or three codes) |
| Photos | Still open (spec section 19) |

After publishing:

1. Put the listing id in `.env` as `IS_ETSY_LISTING_IDS=<id>` and its URL as
   `IS_ETSY_LISTING_URL=https://www.etsy.com/listing/<id>`, then restart the server. The poller
   stores only transactions of the listings in `IS_ETSY_LISTING_IDS`.
2. Make the PDF with the real address and attach it again:
   `node tools/make-how-to-pdf.mjs https://<domain>` (writes `docs/IS-how-to-download.pdf`).

## Title

```
Custom Rhinestone Template from Your Image, Any Photo or Logo to Rhinestone Design, SVG PDF AI EPS DXF PNG Digital Download
```

(123 characters; Etsy allows 140.)

## Description

```
Turn any image into a production-ready rhinestone template: a pet, a portrait, a logo or a drawing.
You see your finished design before you buy.

HOW IT WORKS
1. Go to [IS address] and upload your image (PNG, JPG, BMP, TIFF, WebP, AVIF or SVG, up to 50 MB).
2. Prepare it: background removal, crop, rotate, brightness, contrast and saturation. Choose Colour or Black & white.
3. IS makes your design in a few minutes and shows it next to your image. Not happy? Try again, up to 3 designs.
4. Pick the design you like. IS gives you a code, for example IS-7K3Q-9XPA.
5. Come back to this listing, enter the code in the Personalization field and check out.
6. Go to [IS address]/download, enter your code and download your files.

SIZE
Size depends on your image, usually 13 to 30 cm on the longest side. You see the exact size before you buy.

WHAT YOU GET (one ZIP)
- SVG, true size, one group per stone colour and size
- Production sheet PDF, A4 (mm) and Letter (inches), with stone counts per size and colour
- AI, EPS and DXF for cutting and design software
- PNG at 300 dpi, and a colour preview of the finished design
- The stones are mostly SS6, with some SS4, SS10 and SS16

GOOD TO KNOW
- Nothing is charged until you check out here on Etsy.
- Payments usually appear on the download page within 10 minutes of checkout.
- Your files can be downloaded for 30 days after payment.
- This is a digital item: nothing is shipped. As usual for digital items, there are no refunds once the files have been downloaded.
- Only upload images you own or have the right to use.
- Designs are created with the help of AI tools.

Questions? Send us a message on Etsy and include your IS code.
```

The address is plain text: Etsy does not make it a link. The description names no price, has no buy
button and asks for no contact details outside Etsy (Etsy's Off-Platform Transactions policy). The
AI line is the generic disclosure of Etsy's Creativity Standards; no tool or provider is named
(spec sections 1 and 12).

## Personalization instructions

```
Enter your IS code, for example IS-7K3Q-9XPA
```

IS reads every code in the field (spaces, dashes, lower case, O for 0 and I or L for 1 are all
fine), so a buyer who orders two designs can enter both codes.

## Tags (suggestions, 13 at most, 20 characters each)

```
rhinestone template, rhinestone svg, custom rhinestone, bling template, pet rhinestone, rhinestone design,
rhinestone transfer, rhinestone pattern, logo rhinestone, photo to rhinestone, hotfix template,
rhinestone dxf, rhinestone pdf
```
