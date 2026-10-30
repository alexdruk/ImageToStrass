# Etsy listing designs

Example designs for the PatternNifty Etsy listing, made with the real production pipeline by
`tools/make-listing-designs.mjs` from [subjects.json](subjects.json): upload with background removal
on, one Create design per mode, no tuning, no buyer code and no buyer limit used. The mastiff photo
was cropped to the head and chest with the buyer's crop setting (`x 0.24, y 0.16, w 0.52, h 0.62`);
every other photo is used whole.

Each folder in `designs/` holds `prepared.png` and `tinted.png` at 1200 px on the long side and
`stats.json` (the design's result and the photo's source and licence). The full-size images are in
`data/listing/designs/` (not in git). [designs/overview.png](designs/overview.png) shows every design.

| Subject | Mode | Stones | Natural size | Photo source | Licence | Use in listing |
| --- | --- | ---: | --- | --- | --- | --- |
| [butterfly](designs/butterfly-colour/) | Colour | 1917 | 171 × 142.8 mm (6.73 × 5.62 in) | PickPik, source page not kept | [pickpik Open License](https://www.pickpik.com/license) | yes |
| [car](designs/car-colour/) | Colour | 4856 | 308.2 × 106 mm (12.13 × 4.17 in) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Borgward_concept_car_side_view.jpg) | CC0 | yes |
| [dahlia](designs/dahlia-colour/) | Colour | 3127 | 156 × 158.2 mm (6.14 × 6.23 in) | PickPik, source page not kept | [pickpik Open License](https://www.pickpik.com/license) | yes |
| [hedgehog](designs/hedgehog-colour/) | Colour | 2328 | 136.2 × 106.3 mm (5.36 × 4.18 in) | PickPik, source page not kept | [pickpik Open License](https://www.pickpik.com/license) | yes |
| [mastiff](designs/mastiff-colour/) | Colour | 3714 | 164.9 × 132.4 mm (6.49 × 5.21 in) | PickPik, source page not kept | [pickpik Open License](https://www.pickpik.com/license) | no: the tongue colour is wrong |
| [mastiff](designs/mastiff-bw-stencil/) | Black & white Bold | 3701 | 163.2 × 132.6 mm (6.42 × 5.22 in) | PickPik, source page not kept | [pickpik Open License](https://www.pickpik.com/license) | yes |
| [mastiff](designs/mastiff-bw-halftone/) | Black & white Shaded | 4141 | 179.1 × 144 mm (7.05 × 5.67 in) | PickPik, source page not kept | [pickpik Open License](https://www.pickpik.com/license) | yes |
| [parrot](designs/parrot-colour/) | Colour | 2375 | 111.1 × 114.5 mm (4.37 × 4.51 in) | PickPik, source page not kept | [pickpik Open License](https://www.pickpik.com/license) | no: the photo cuts the head |
| [person](designs/person-colour/) | Colour | 4685 | 167.4 × 204.2 mm (6.59 × 8.04 in) | PickPik, source page not kept | [pickpik Open License](https://www.pickpik.com/license) | no: the photo is black and white, so the skin colour is made up and wrong |
| [person](designs/person-bw-stencil/) | Black & white Bold | 5048 | 171.1 × 207.9 mm (6.74 × 8.18 in) | PickPik, source page not kept | [pickpik Open License](https://www.pickpik.com/license) | yes |
| [person](designs/person-bw-halftone/) | Black & white Shaded | 7154 | 200.9 × 249.5 mm (7.91 × 9.82 in) | PickPik, source page not kept | [pickpik Open License](https://www.pickpik.com/license) | yes |
| [stag-beetle](designs/stag-beetle-colour/) | Colour | 1514 | 204.4 × 92.3 mm (8.05 × 3.63 in) | PickPik, source page not kept | [pickpik Open License](https://www.pickpik.com/license) | yes |

The PickPik source pages were not kept, and the photo files carry no source in their metadata.

## Colour portraits (PN-04d)

Six CC0 portrait photos from Wikimedia Commons, all first posted on Unsplash before June 2017
(when Unsplash photos were CC0), are in [portraits/candidates.json](portraits/candidates.json), with
each file page, author, Unsplash page and date, and are shown on
[portraits/candidates.png](portraits/candidates.png). The files are in
`data/listing/candidates/portraits/` (not in git). Candidates 4 and 5 were not made: in 4 the skin
has been edited to grey, and 5 is a wide-angle phone close-up that cuts off the head. Candidates 1, 2,
3 and 6 were made in Colour exactly like the designs above (background removal on, no adjustments, no
tuning), each on its first try. [portraits/overview.png](portraits/overview.png) shows them.

| # | Subject | Mode | Stones | Natural size | Photo source | Licence | Use in listing |
| ---: | --- | --- | ---: | --- | --- | --- | --- |
| 1 | [portrait-freckles](designs/portrait-freckles-colour/) | Colour | 3176 | 137.1 × 200.8 mm (5.4 × 7.9 in) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Smile_with_Freckles_(Unsplash).jpg), Gabriel Silvério | CC0 | not decided |
| 2 | [portrait-curls](designs/portrait-curls-colour/) | Colour | 4764 | 174.6 × 174.7 mm (6.88 × 6.88 in) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Confident_Eye_Contact_(Unsplash).jpg), Tanja Heffner | CC0 | not decided: the skin came out much lighter than in the photo |
| 3 | [portrait-elder](designs/portrait-elder-colour/) | Colour | 3936 | 143.1 × 177.4 mm (5.63 × 6.99 in) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Karen_Elder_(Unsplash).jpg), Capturing the human heart. | CC0 | not decided |
| 6 | [portrait-glasses](designs/portrait-glasses-colour/) | Colour | 3089 | 163.1 × 164.2 mm (6.42 × 6.46 in) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Man_vanguard_glasses_outdoors_(Unsplash).jpg), Seth Doyle | CC0 | not decided: one eye is missing |

### Leonardo da Vinci paintings (PN-04d follow-up)

Three public-domain Leonardo portraits of women from Wikimedia Commons (candidates 8–10 in
[portraits/candidates.json](portraits/candidates.json)), made the same way. Ginevra de' Benci is
Commons' 4000 px copy of the 10483 × 11110 file, which is over the upload limit. The Mona Lisa was
left out on purpose. Each was made on its first try; Lady with an Ermine and La Belle Ferronnière
were then made once more, as a buyer's Try again with the same settings. The second Ermine is kept
(on the first, white stones scattered over the ermine looked like holes). A third Ermine with the buyer's brightness at −15
came out worse (the ermine pure white and grey) and was not kept. The first Ferronnière is
kept: the second was red again, because the pipeline turns her dark brownish-red dress bright red
every time.

| # | Subject | Mode | Stones | Natural size | Photo source | Licence | Use in listing |
| ---: | --- | --- | ---: | --- | --- | --- | --- |
| 8 | [painting-ermine](designs/painting-ermine-colour/) | Colour | 3771 | 137 × 204 mm (5.39 × 8.03 in) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Leonardo_da_Vinci_(1452-1519)_-_Lady_with_an_Ermine_%E2%80%93_Portrait_of_Cecilia_Gallerani_(ca._1473%E2%80%931536)_-_MNK_XII-209_-_National_Museum_Krak%C3%B3w.jpg), National Museum in Kraków | Public domain | not decided |
| 9 | [painting-ferronniere](designs/painting-ferronniere-colour/) | Colour | 3950 | 143.7 × 217.3 mm (5.66 × 8.56 in) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:La_Belle_Ferroni%C3%A8re_-_Google_Arts.jpg), Google Arts & Culture | Public domain | not decided: the dark brownish-red dress comes out bright red with gold |
| 10 | [painting-ginevra](designs/painting-ginevra-colour/) | Colour | 3660 | 134.7 × 178 mm (5.3 × 7.01 in) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Leonardo_da_Vinci_-_Ginevra_de%27_Benci_-_Google_Art_Project.jpg), Google Art Project | Public domain | not decided: white blotches on the face |
