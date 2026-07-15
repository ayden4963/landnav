# Land Nav Plotter

An offline tool for plotting MGRS points, azimuths, and distances on a photographed map. Runs as a Progressive Web App (PWA) — install once, then works with zero connectivity, GPS included.

## 1. Install on your phone

This needs to be "served" from somewhere once so your phone can install it. After that, it's cached and works fully offline (a plain `file://` page can't register a service worker or reliably use the compass, which is why this step matters).

**Recommended: GitHub Pages (free, gives you HTTPS, works long-term)**
1. Create a new GitHub repo, upload all files in this folder (keeping the `icons/` subfolder).
2. Settings → Pages → deploy from the `main` branch.
3. Open the resulting `https://yourname.github.io/reponame/` URL on your phone.
4. Safari: Share → "Add to Home Screen." Chrome/Android: menu → "Install app."

**Quick local alternative (no GitHub account, same Wi-Fi network only):**
```
cd landnav
python3 -m http.server 8000
```
Then on your phone (same Wi-Fi), visit `http://<your-computer's-LAN-IP>:8000`. This works for testing, but iOS will likely block compass access over plain HTTP — GPS, MGRS plotting, and measurement all work fine either way.

Once added to your home screen and opened at least once, the app is cached and will keep working with the phone in airplane mode or in a dead zone.

## 2. How to use it

**Add a map.** Take or import a photo of your paper map.

**Calibrate (do this first).** Tap "Calibrate," tap a point on the photo where two grid lines cross, then type the MGRS coordinate printed at that intersection. Repeat for at least 2 points — but use **4 points near the photo's corners** whenever you can. A photo taken at an angle isn't a clean rescaled copy of the map, and 4 points let the app correct for that tilt (a "homography" transform); 2 points can only correct for straight scale + rotation. The badge in the top bar shows your calibration method and estimated accuracy (RMS error in meters) — if it's showing tens of meters, retake the photo straighter-on or recalibrate with better-spread points.

**Waypoint.** Tap "Waypoint," tap a spot, name it, and pick a category (rally point, danger area, water, casualty collection, objective, other). Saved waypoints persist offline and show up in "List."

**Measure.** Tap "Measure," then tap two points. You'll get distance, grid azimuth, magnetic azimuth, and back azimuth.

**Declination.** Set this in Settings before magnetic azimuth will show. Enter the G-M angle **printed in your specific map's margin**, not a generic estimate — that's the number the map's own printer calculated for its edition, which is more reliable than a generalized model, especially on an older map.

**Live.** Turns on your phone's GPS (works with no cell signal — GPS is a separate satellite receiver) and plots your position live on the calibrated map. Compass heading needs HTTPS hosting and a permission prompt (iOS); treat it as approximate and verify it against a known bearing before trusting it.

**Backup.** Settings → export saves the map photo + all calibration + waypoints as one `.json` file. Import it back later or move it to another phone.

## 3. Known limits — read before you rely on this in the field

- **No automatic grid detection.** You must manually enter MGRS values for control points yourself, read off the actual map. There's no reliable way to auto-detect grid lines from a photo, and any tool claiming to is guessing.
- **Manual declination only.** There's no built-in magnetic model — it deliberately relies on your map's printed G-M angle for accuracy.
- **Assumes your map area sits in one UTM zone.** If your calibration points straddle a UTM zone boundary, accuracy will degrade. This is rare for a single map sheet.
- **Compass sensor accuracy varies by phone** and can be thrown off by nearby metal — it's a convenience reference, not a replacement for your baseplate compass.
- **This has been tested against reference coordinate conversions**, but it has not been field-validated against a physical compass and pace count. Sanity-check it against known distances/bearings before trusting it for real navigation decisions.
