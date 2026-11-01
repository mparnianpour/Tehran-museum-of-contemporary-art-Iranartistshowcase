# Frame AR: Iranian Artist Showcase

A web AR slideshow for an empty picture frame. Visitors open a link on their phone, point the camera at the frame, and artworks appear inside it, changing like a slideshow with a choice of transition effects. It runs in the phone's browser (iOS Safari and Android Chrome) with no app to install.

Frames and walls will change between exhibitions, so each frame is a **setup** you can create in a few minutes with the built-in setup tool. The artworks are kept separately in `slideshow.json`.

- `index.html`: the AR viewer.
- `setup.html`: the setup tool for a new frame or wall.
- `slideshow.json`: the artworks and the transition settings.
- `config.json`: the title, languages, and which setup is active.

---

## Quick start

1. **Publish the site with GitHub Pages.** In the repository, open Settings → Pages → *Deploy from a branch*, then pick the branch and `/ (root)`. The camera only works over **https**, and Pages provides that.
2. Open `https://<your-user>.github.io/<repo>/` on a phone, tap **Start AR**, and point the camera at the frame.
3. To check things on a computer, open `index.html?preview=1`. It shows the slideshow on the setup photo without a camera.

To test locally, run `python3 -m http.server 8000` in this folder and open <http://localhost:8000>. A desktop browser treats `localhost` as secure. A phone on the same Wi-Fi does not, so test on the phone through the Pages link instead.

---

## Changing the artworks (`slideshow.json`)

Put your images in `artworks/` (JPEG or PNG, up to about 2048 px on the long side). Then list them in the file:

```json
{
  "settings": {
    "interval": 6,
    "transitionDuration": 1.4,
    "effect": "fade",
    "fit": "cover"
  },
  "slides": [
    { "src": "artworks/work-01.jpg", "title": "Untitled", "artist": "Artist Name", "year": "1975",
      "fa": { "title": "بی‌عنوان", "artist": "نام هنرمند" } },
    { "src": "artworks/work-02.jpg", "title": "…", "effect": "iris", "duration": 10 }
  ]
}
```

The files in `artworks/` now are generated **placeholders**. Replace them with your own images.

**Settings**

| key | default | meaning |
|---|---|---|
| `interval` | `6` | seconds each artwork stays on screen |
| `transitionDuration` | `1.4` | seconds per transition |
| `effect` | `"fade"` | transition effect (see the list below) |
| `direction` | `"left"` | direction for slide, wipe and blinds: `left`, `right`, `up`, `down` |
| `fit` | `"cover"` | `cover` fills the opening and crops the image; `contain` shows the whole image on a mat |
| `background` | `"#ebe6dc"` | mat colour around `contain` images |
| `kenBurns` | `false` | slow zoom and pan while each artwork is shown |
| `kenBurnsZoom` | `0.1` | how far the Ken Burns zoom goes |
| `loop` / `shuffle` | `true` / `false` | play order |
| `pauseWhenHidden` | `true` | don't advance while the frame is out of view, so visitors don't miss works |
| `effects` | all | the effects offered in the on-screen picker and used by `random` |

**Per-slide options:** `effect`, `direction`, `fit`, `duration` (seconds on screen), `transitionDuration` and `kenBurns` override the settings for that slide. `title`, `artist`, `year` and `medium` appear in the caption. A `"fa": {…}` block gives the Persian caption text.

### Transition effects

| id | effect |
|---|---|
| `fade` | crossfade |
| `slide` | the new image pushes the old one out |
| `wipe` | a soft-edged wipe |
| `zoom` | zooms through into the next image |
| `dissolve` | organic ink-like dissolve |
| `iris` | circular reveal from the centre |
| `blinds` | venetian blinds |
| `pixelate` | pixelates out, then back in |
| `dip` | fades through black |
| `cut` | instant change |
| `random` | a different effect each time |

Visitors can also change the effect, go back or forward, and pause from the on-screen controls, or by swiping across the screen.

---

## Setting up a new frame or wall (`setup.html`)

When the frame or the wall behind it changes, make a new setup. You can do it all on a phone.

1. Open `setup.html` and **take or choose a photo** of the frame on its wall, standing straight in front of it. Include some wall around the frame, and take it in the light the exhibition will have.
2. **Drag the four handles** onto the inner corners of the frame opening, where the picture should start. A magnifier helps with precision.
3. Enter the opening's **inner size** if you can measure it (any unit). Otherwise the shape is estimated from the photo. The *frame & wall* slider sets how much of the surroundings the phone uses to recognise the frame; more is better, up to the edge of the photo.
4. Adjust the **picture edge**, the **frame shadow** and the **brightness** while you watch the preview.
5. **Compile** the tracking data. This takes about 10 seconds on a laptop. The tool shows the detected feature points and a rough tracking-quality rating.
6. To try it, tap **Test AR on this device**. The setup is saved in this browser only, so it runs straight away without uploading anything. When you are happy with it, tap **Download setup (.zip)**, unzip it at the top of the site (it creates `setups/<id>/`), and commit it.

You can reopen an existing setup to adjust it: open *Edit an existing setup instead* and type its ID.

**Tips for reliable tracking**

- The phone recognises the frame from visual detail, such as wood grain, chips, tile joints and nearby objects. Plain white walls with a plain frame are hard to track. If the rating is *Poor*, include more surroundings, improve the lighting, or add some texture near the frame.
- Take the setup photo in the same light, and with the same surroundings, that visitors will see.
- If the wall around the frame changes (posters, signs, furniture), make a new setup.

### Switching setups

- To change the default, set `"setup": "frame-02"` in `config.json`.
- To pick one per link, use `index.html?setup=frame-02`. This is handy for one QR code per frame.
- A setup can carry its own playlist: add `"slideshow": "../../slideshow-room2.json"` to its `setup.json`.

---

## URL parameters

These are useful for testing, QR codes, and tuning on site without editing files.

| parameter | example | effect |
|---|---|---|
| `setup` | `?setup=frame-02` | which setup to use (a name, a path, or `local:<id>` for one saved on this device) |
| `slideshow` | `?slideshow=room2.json` | which slideshow file to use |
| `preview` | `?preview=1` | no camera: shows the slideshow over the setup photo |
| `autostart` | `?autostart=1` | skip the start screen |
| `effect`, `interval`, `duration`, `direction`, `fit`, `kenburns`, `shuffle` | `?effect=wipe&interval=4` | override slideshow settings |
| `lang` | `?lang=fa` | interface language (`en`, `fa`) |
| `controls`, `caption`, `effectPicker`, `navigation`, `swipe` | `?controls=0` | show or hide parts of the interface |
| `bleed`, `exposure` | `?bleed=0.01` | adjust the picture edge or brightness |
| `filterMinCF`, `filterBeta` | `?filterBeta=0.05` | tracking smoothing (see below) |
| `debug` | `?debug=1` | outlines the tracking image and opening, and shows the tracking rate |

**Tracking smoothing:** a lower `filterMinCF` gives steadier tracking at rest but more lag, and a higher `filterBeta` follows fast movement more closely. The defaults are `0.001` and `0.01`.

---

## `config.json`

```json
{
  "title": "Iranian Artist Showcase",
  "subtitle": "Tehran Museum of Contemporary Art",
  "language": "en",
  "languages": ["en", "fa"],
  "strings": { "fa": { "title": "نمایشگاه هنرمندان ایرانی", "subtitle": "موزهٔ هنرهای معاصر تهران" } },
  "setup": "frame-01",
  "slideshow": "slideshow.json",
  "ui": { "startScreen": true, "scanningHint": true, "caption": true, "navigation": true, "effectPicker": true, "swipe": true }
}
```

`strings` can override any interface text per language; see `js/i18n.js` for the keys.

## `setup.json` (written by the setup tool)

| key | meaning |
|---|---|
| `target`, `preview` | the compiled tracking file (`target.mind`) and the straightened image it was made from |
| `targetSize` | `[width, height]` of the tracking image in pixels |
| `opening` | the four corners of the picture area in tracking-image pixels: top-left, top-right, bottom-right, bottom-left |
| `openingAspect` | real width ÷ height of the opening |
| `bleed` | grows (+) or shrinks (−) the picture past the opening, as a fraction of its width |
| `exposure` | picture brightness, to match the room |
| `innerShadow` | `strength` and `size` of the shadow the frame casts on the picture |
| `tracking` | MindAR smoothing and tolerance settings |
| `calibration` | the photo, corners and margin it was made from, so the tool can reopen it |

## About `setups/frame-01`

This setup was made with the setup tool from the photo of the dark wood frame on the white tiled wall. The opening was not measured, so its shape was estimated from the photo as 0.663 (close to 2:3, such as 40 × 60 cm). If the real size differs, reopen it in the setup tool, enter the measurements, and compile again. If you hang the frame on a different wall, make a new setup.

In automated tests with a simulated phone camera, it locked on within about 4 seconds. With the camera held still, the picture lined up with the opening to within about 1–3% of the frame width.

## Files

```
index.html, css/viewer.css     AR viewer
setup.html, css/setup.css      setup tool
js/viewer.js                   viewer app (AR mode + preview mode)
js/slideshow.js                timing, preloading, navigation, Ken Burns
js/transitions.js              transition shader and effect list
js/frame-geometry.js           maps the picture onto the opening
js/config.js                   loads config, setup and slideshow; URL overrides
js/setup-tool.js, setup-core.js  setup tool UI, straightening, compiling, zip export
js/homography.js               perspective maths
js/local-store.js              on-device storage for test setups
js/i18n.js                     English and Persian interface text
setups/<id>/                   one folder per frame setup
artworks/                      slideshow images
vendor/                        MindAR 1.2.5 and three.js r160 (MIT), bundled so the
                               site works without third-party CDNs
```

## Credits

- [MindAR](https://github.com/hiukim/mind-ar-js) (MIT): image tracking.
- [three.js](https://threejs.org) (MIT): rendering.
- Their licence files are in `vendor/`.
