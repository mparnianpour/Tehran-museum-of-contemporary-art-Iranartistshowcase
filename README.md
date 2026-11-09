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
3. Enter the opening's **inner size** if you can measure it (any unit). Otherwise the shape is estimated from the photo. The *frame & wall* slider sets how much of the surroundings the phone uses to recognise the frame; more is better, up to the edge of the photo. **If the wall behind the frame may change**, keep the straightened image within the frame's outer edge, so only the frame is recognised. **Ignore what's inside the frame** (on by default) does the same for the opening.
4. Adjust the **picture edge**, the **frame shadow** and the **brightness** while you watch the preview.
5. **AprilTags (optional):** any tags in the photo, inside the frame or on the wall, are found and saved automatically. For tags on the wall, enter how far the frame's inner edge stands out from the wall (see below).
6. **Pillars and walls (optional):** if a pillar or the side wall of an alcove stands out in front of the picture, enter how far it sticks out, for each side. The viewer then lets it hide the picture from the side, as it hides the real surface (see below).
7. **Compile** the tracking data. This takes about 10 seconds on a laptop. The tool shows the detected feature points and a rough tracking-quality rating.
8. To try it, tap **Test AR on this device**. The setup is saved in this browser only, so it runs straight away without uploading anything. When you are happy with it, tap **Download setup (.zip)**, unzip it at the top of the site (it creates `setups/<id>/`), and commit it.

You can reopen an existing setup to adjust it: open *Edit an existing setup instead* and type its ID.

**Tips for reliable tracking**

- The phone recognises the frame from visual detail, such as wood grain, chips, tile joints and nearby objects. Plain white walls with a plain frame are hard to track. If the rating is *Poor*, include more surroundings, improve the lighting, or add some texture near the frame.
- **Detail that repeats is hard too**, even when there's a lot of it. Carved, gilded frames (beading, rosettes) look alike from one spot to the next, so image tracking has trouble locking on. For frames like that, AprilTags should be the main tracker (see below).
- **Plain surfaces**, such as a blank paper or canvas panel with no frame, can't be recognised by image tracking at all. When step 6 rates tracking *Poor*, the tool switches on **Hold the picture with the tags only** (step 5). The viewer then pauses image tracking, which saves the phone's battery, and the AprilTags do all the work. The tags must be in the setup photo.
- Take the setup photo in the same light, and with the same surroundings, that visitors will see.
- If the wall around the frame changes (posters, signs, furniture), make a new setup.

### Switching setups

- To change the default, set `"setup": "frame-02"` in `config.json`.
- To pick one per link, use `index.html?setup=frame-02`. This is handy for one QR code per frame.
- A setup can carry its own playlist: add `"slideshow": "../../slideshow-room2.json"` to its `setup.json`.

---

## Holding the picture from the side (AprilTags)

Image tracking recognises the frame by its visual detail. That works well from the front, but from a steep side angle the detail is squashed, so the picture drifts or disappears. Printed **AprilTags** (black-and-white square codes, the `tag36h11` family) fix this, because they stay readable at steep angles. A tag can go in either of two places:

- **Inside the frame.** Visitors don't see it in AR, because the artwork is drawn over it. One tag is enough.
- **On the wall beside the frame.** Use **two**, one each side, at mid-height. This works whatever is inside the frame, and suits frames that are hard for image tracking, such as the ornate gold frame.
- **On a plain panel with no frame.** Put **two** on the panel itself, near opposite corners, for example top-left and bottom-right, about 10 cm in from the edges. They're on the same surface as the picture, so no depth is needed, and the artwork covers them in AR.
- **Anywhere else, at any angle.** For example, on a pillar's front or on a surface turned towards the visitors. In step 5, enter the **printed tag size** (the black square) along with the size in step 3. The setup tool then places every tag in 3D from the setup photo, so there's nothing to measure: no angle and no distance. It reads the photo's lens from its EXIF data when present (phone photos include it); otherwise it works it out from the perspective. **The tags are on upright surfaces** (on by default) makes this much more precise: in tests, an angled tag was placed to within a few millimetres. Visitors will see tags that the artwork doesn't cover.

Keep the tags inside the area visitors will frame with their phone, ideally two of them in view at once. With one small tag, the whole picture is worked out from that one square, so small errors get magnified across the panel.

**How to use it**

1. Open `apriltag.html` and print the tags at 100% scale on matte paper. Standard tag36h11 images from the AprilTag project work too.
   - **Wall tags:** use **200 mm** black squares (A3 paper), IDs 0 and 1.
   - **Inside the frame:** a black square about a third of the opening's width.
2. Fix them flat.
   - **Wall tags** go 15–20 cm from the frame's outer edge, so that from the side the frame's own depth doesn't hide the far one.
   - **A tag inside the frame** goes away from the edges.
3. Tell the viewer where the tags are:
   - **Best:** make a new setup with the tags in the photo. The setup tool finds them anywhere in the photo and saves their exact positions in `setup.json` (`apriltag.tags`). Visitors can then start from any angle.
     - For **wall tags**, also measure the opening's width and height, and **how far the frame's inner edge stands out from the wall**. Enter these in steps 3 and 5. The frame's depth puts the opening in front of the tags; without this, the picture slides sideways from the side (about 10% of the opening's width at 55° in tests).
   - **Tags inside the frame, without a new setup:** just put the tag up. The first time a phone recognises the frame from the front, the viewer works out where the tag is and remembers it on that phone.

**What happens while viewing**

- With **two or more tags in view**, the tags hold the picture at any angle.
- With one tag, image tracking holds it from the front (under 30° by default), and the tag takes over beyond that angle or whenever image tracking loses the frame. A short blend stops the picture jumping.
- For tags on the wall, the viewer works in real 3D and places the opening in front of the wall by the measured depth. This needs the phone's real focal length, which the viewer estimates from the tags themselves whenever they're seen at an angle, and remembers on that phone. It doesn't rely on the image tracker's fixed 45° camera assumption, which phones don't match.
- Small, distant tags are read from an enlarged copy of the camera image. That lets 15–20 cm tags be read from 2–3 m away.
- In tags-only mode, image tracking is paused, so the viewer asks the phone for an HD camera stream instead. That makes distant tags larger in pixels.

**How well it works (simulated phone camera, headless browser)**

| test | picture shown | error, % of frame width |
|---|---|---|
| 55° side view from the start, image tracking only | 94% | 8.1% mean |
| 55° side view from the start, tag position from the setup photo | 100% | 2.4% mean, 1.7% median |
| front, then a 60° side view, image tracking only | 33% of side-view shots | 15% mean while shown |
| front, then a 60° side view, tag position learned live | 64–85% of side-view shots | 1.5–3.7% while holding steady |
| gold frame, 6 cm deep, two 15 cm wall tags, depth **not** entered | 100% | front 3.5%, 50–55°: 14% (median) |
| gold frame, 6 cm deep, two 15 cm wall tags, depth entered | 100% | front 1.4%, 50–55°: 5.5% (median) |
| gold frame, 6 cm deep, two **20 cm** wall tags, depth entered | 100% | front 1.3%, 35–50°: 3.6%, 50–55°: 2.2% (median) |
| plain 140 × 170 cm panel, two 20 cm tags on it, **tags only** | 100% | 55°: 1.6–3.9% |
| alcove panel 350 × 300 cm, one 30 cm tag on the panel and one on the pillar **turned 40°**, placed in 3D from the setup photo | 100% | both tags in view: 1.5–2.6% at ±40°; only one tag in view: 5–10% |

The test machine processes only about 12–15 frames per second, so it shows more lag while the camera is moving than a phone would.

The tag positions found by the setup tool were within 0.5–0.8 px of the truth on a 200 px tag. For wall tags, after correcting for depth, they were within 3 mm of the truth; without the correction they were 1.3–1.9 cm off. With 15 cm wall tags, the far tag was sometimes too foreshortened to read at 55°. With 20 cm tags, both were read in 26 of 27 shots.

**Settings** (`apriltag` in `setup.json`, all optional): `enabled` (default `true`), `learn` (`true`), `obliqueAngle` (`30` degrees), `tags` and `wallOffset`. The last two are written by the setup tool; `wallOffset` is how far the tags' surface is behind the picture in tracking-image pixels, negative when it's in front, e.g. on a pillar. `tracking.image: false` turns image tracking off (tags only). For testing, turn them off with `?apriltag=0` or `?learn=0`, or try `?obliqueAngle=20`. With `?debug=1`, tag positions are outlined (green: from the setup, cyan: learned), and the readout shows what is holding the picture and the viewing angle.

### Pillars and walls that hide the picture

Without them entered, the AR picture is drawn over everything, so seen from the side it would cover a pillar or alcove wall standing in front of the panel. Enter each side in the setup tool (step 6): how far it **sticks out** in front of the picture, and how much it **covers the edge** when seen straight on (usually 0).

Every frame, the viewer works out which part of the panel each pillar or wall hides from where the phone is. It uses the phone's real position, found from the tags, and leaves that part of the picture see-through, so the real pillar stays in front. The measured size from step 3 is needed. In `setup.json` they are `occluders`: boxes in tracking-image pixels, with `near` as how far they stand out.

In a simulated alcove (350 × 300 cm panel, a wall and a pillar each standing 100 cm out, camera at ±40°), the picture was drawn over the wall or pillar for **11%** of the hidden area with them entered, compared with **83%** without. The 11% is a thin edge band that lags slightly while the phone moves. It still covered 90% of the visible panel.

Keep tags far enough in from the sides that a pillar doesn't hide them from the side, roughly as far in as the pillar sticks out.

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
| `apriltag` | optional AprilTag settings; `tags`: each tag's ID and corners in tracking-image pixels; `wallOffset`: how far the tags' wall is behind the opening's edge (tracking-image pixels) |
| `occluders` | pillars or walls in front of the picture: `box` [x0, y0, x1, y1] beside it and `near` (how far they stand out), in tracking-image pixels |
| `calibration` | the photo, corners and margin it was made from, so the tool can reopen it |

## About `setups/frame-01`

**Update:** the gold frame is being replaced by a **plain cream panel** of three vertical sheets, with no frame. The panel is too plain for image tracking (5 feature points in its photo), so it will use **tags only**. The photo received so far cuts off the panel's top and bottom, so the setup can't be made yet.

**Still needed:**

1. Two 200 mm tags (IDs 0 and 1), fixed on the panel near opposite corners. Wall tags beside the panel also work; then also measure how far the panel's surface stands off the wall.
2. A straight-on photo showing all four edges of the panel, with the tags up.
3. The panel's width and height.

Until then, `frame-01` below is still the gold frame.

This is the **ornate gold frame** on the grey gallery wall, made with the setup tool from its photo. Because the wall behind it may change, the tracking image is the frame alone: it ends just inside the frame's outer edge, and the inside of the opening is ignored. The opening wasn't measured; its shape was estimated from the photo as 0.798 (close to 4:5, such as 80 × 100 cm).

**Image tracking alone does not reliably recognise this frame.** Its carving repeats, and the gilding is shiny. In tests with your photo, it never locked on to the frame alone, and only now and then when wall was included. So this frame needs the AprilTags.

**To finish it:**

1. Print tags **0** and **1** at **200 mm** on A3 (`apriltag.html`).
2. Fix them on the wall to the left and right of the frame, at mid-height, 15–20 cm from its outer edge.
3. Measure the opening's width and height, and how far the frame's inner edge stands out from the wall.
4. Take a new setup photo with the tags up. In `setup.html`, enter the sizes in step 3 and the depth in step 5, and compile.
5. Download the setup as `frame-01` and replace this folder.

Until then, the viewer has no reliable way to hold the picture on this frame. With the tags in place, tests showed the picture held 100% of the time, within 1–4% of the opening's width, from the front to 55° to the side.

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
js/camera.js                   real 3D camera maths: focal length from tags, pose, depth
js/occlusion.js                which part of the picture a pillar or wall hides, from where the phone is
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
