# Frame AR: Iranian Artist Showcase

A web AR slideshow for an empty picture frame. Visitors open a link on their phone, point the camera at the frame, and artworks appear inside it, changing like a slideshow with a choice of transition effects. It runs in the phone's browser (iOS Safari and Android Chrome) with no app to install.

Frames and walls will change between exhibitions, so each frame is a **setup** you can create in a few minutes with the built-in setup tool. The artworks are kept separately in `slideshow.json`.

- `index.html`: the AR viewer.
- `setup.html`: the setup tool for a new frame or wall.
- `apriltag.html`: prints an AprilTag that keeps the picture in place when visitors look from the side.
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

## Holding the picture from the side (AprilTags)

Image tracking recognises the frame by its visual detail. That works well from the front, but from a steep side angle the detail is squashed, so the picture drifts or disappears. A small printed **AprilTag** (a black-and-white square code, the `tag36h11` family) placed inside the frame fixes this. Tags stay readable at steep angles. Visitors don't see the tag in AR, because the artwork is drawn over it.

**How to use it**

1. Open `apriltag.html` and print a tag at 100% scale on matte paper. Choose a black square about a third of the opening's width, for example 120–150 mm for a 40 × 60 cm frame. Standard tag36h11 images from the AprilTag project work too.
2. Fix it flat on the wall inside the frame opening, away from the edges, so the frame's lip doesn't hide it from the side.
3. Tell the viewer where the tag is, in one of two ways:
   - **Best:** make a new setup with the tag in the photo. The setup tool finds it and saves its exact position in `setup.json` (`apriltag.tags`). Visitors can then start from any angle.
   - **No new setup:** just put the tag up. The first time a phone recognises the frame from the front, the viewer works out where the tag is and remembers it on that phone. From then on, the tag holds the picture when the visitor walks to the side.

Two or more tags, far apart, make side views steadier still; the viewer uses every tag it can see.

**What happens while viewing**

- From the front (under 30° by default), image tracking holds the picture.
- Beyond that angle, or whenever image tracking loses the frame, the tag takes over, with a short blend so the picture doesn't jump.
- The tag mapping is projective, so it stays exact even though phone lenses differ from the camera model the image tracker assumes.

**How well it works (simulated phone camera, headless browser)**

| test | picture shown | error, % of frame width |
|---|---|---|
| 55° side view from the start, image tracking only | 94% | 8.1% mean |
| 55° side view from the start, tag position from the setup photo | 100% | 2.4% mean, 1.7% median |
| front, then a 60° side view, image tracking only | 33% of side-view shots | 15% mean while shown |
| front, then a 60° side view, tag position learned live | 64–85% of side-view shots | 1.5–3.7% while holding steady |

The test machine processes only about 12–15 frames per second, so it shows more lag while the camera is moving than a phone would. The tag positions found by the setup tool were within 0.5–0.8 px of the truth on a 200 px tag.

**Settings** (`apriltag` in `setup.json`, all optional): `enabled` (default `true`), `learn` (`true`), `obliqueAngle` (`30` degrees), and `tags` (written by the setup tool). For testing, turn them off with `?apriltag=0` or `?learn=0`, or try `?obliqueAngle=20`. With `?debug=1`, tag positions are outlined (green: from the setup, cyan: learned), and the readout shows what is holding the picture and the viewing angle.

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
| `apriltag`, `learn`, `obliqueAngle` | `?apriltag=0` | turn AprilTag holding or learning off, or change the switch-over angle |
| `debug` | `?debug=1` | outlines the tracking image, opening and tags, and shows what is holding the picture |

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
| `apriltag` | optional AprilTag settings, and `tags`: each tag's ID and corners in tracking-image pixels |
| `calibration` | the photo, corners and margin it was made from, so the tool can reopen it |

## About `setups/frame-01`

This setup was made with the setup tool from the photo of the dark wood frame on the white tiled wall. The opening was not measured, so its shape was estimated from the photo as 0.663 (close to 2:3, such as 40 × 60 cm). If the real size differs, reopen it in the setup tool, enter the measurements, and compile again. If you hang the frame on a different wall, make a new setup.

In automated tests with a simulated phone camera, it locked on within about 4 seconds. With the camera held still, the picture lined up with the opening to within about 1–3% of the frame width.

Its photo has no AprilTag yet. Once you put one in the frame, the viewer learns its position automatically (see above). For the most accurate result, make a new setup photo that includes the tag.

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
js/tracking-fusion.js          chooses image tracking or AprilTags; learns tag positions
js/tag-detector.js, apriltag-worker.js  AprilTag detection off the main thread
js/tag-pose.js                 maps tag corners to the picture's position, in MindAR's terms
apriltag.html                  printable AprilTags
setups/<id>/                   one folder per frame setup
artworks/                      slideshow images
vendor/                        MindAR 1.2.5, three.js r160 and js-aruco2 2.0 (MIT),
                               bundled so the site works without third-party CDNs
```

## Credits

- [MindAR](https://github.com/hiukim/mind-ar-js) (MIT): image tracking.
- [three.js](https://threejs.org) (MIT): rendering.
- [js-aruco2](https://github.com/damianofalcioni/js-aruco2) (MIT): AprilTag detection.
- AprilTag tag36h11 codes: © The Regents of the University of Michigan, APRIL Robotics Lab (BSD 2-clause; the notice is in the dictionary file).
- Their licence files are in `vendor/`.
