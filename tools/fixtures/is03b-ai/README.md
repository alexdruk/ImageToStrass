# IS-03b AI images (test fixtures)

The nine saved model outputs of the IS-03b measurements (`tools/measure-is03b.mjs`, 18 Oct 2026,
prompt version 2): the images the strass service laid out into the IS-03b designs. The layouts
made from them are `../is03b/<id>.json` and `../is03b-rejected/car-rule.json`.

They are not buyer images. Each was made from one of the CC0 photos (public domain dedication,
Wikimedia Commons) in `services/strass/tests/fixtures/photos/` (see `SOURCES.md` there):

| File | Photo | Source |
| --- | --- | --- |
| `dog-rule-output.png`, `dog-norule-output.png` | `dog.jpg` | https://commons.wikimedia.org/wiki/File:Dog_on_dirt_road.jpg |
| `cat-rule-output.png`, `cat-norule-output.png` | `cat.jpg` | https://commons.wikimedia.org/wiki/File:Domestic_shorthair_cat_portrait_in_grass.jpg |
| `mug-rule-output.png`, `mug-norule-output.png` | `mug.jpg` | https://commons.wikimedia.org/wiki/File:Mug_image.jpg |
| `giraffe-rule-output.png` | `giraffe.jpg` | https://commons.wikimedia.org/wiki/File:Giraffe_posing_in_the_grass.jpg |
| `dachshund-rule-output.png` | `dachshund.jpg` | https://commons.wikimedia.org/wiki/File:1_Year_Old_Miniature_Dachshund.jpg |
| `car-rule-output.png` | `car.jpg` | https://commons.wikimedia.org/wiki/File:Borgward_concept_car_side_view.jpg |

`-rule` / `-norule`: with or without the "about 60 stones across" sentence (IS-03b).

Every metadata chunk was removed (only IHDR, IDAT and IEND are kept; the decoded pixels are
identical to the saved outputs), so the files carry no provider metadata.

Used by `tools/tinted-comparison.mjs`, `tools/is05b-results.mjs` and
`services/strass/scripts/is05b_runs.py` (via the paths given to it).
