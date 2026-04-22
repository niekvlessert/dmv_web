# Dutch MoonSound Veterans Web Menu

This web app recreates the MSX disk menu from `DMV1`, `DMV2`, `DMV3`, and `DMVFT`, and plays tracks in-browser using `libmoonsound` compiled with Emscripten.

## Files

- `index.html`, `styles.css`, `app.js`: website UI and playback logic
- `catalog.json`: extracted menu entries from `DISKEXEC.BAS`
- `player/moonsound.js` + `player/moonsound.wasm`: Emscripten build output
- `assets/yrw801.rom`, `assets/waves.dat`: required playback core assets

## Regenerate Menu Catalog

From repository root:

```bash
node scripts/extract_catalog.mjs
```

## Build WASM Player

From repository root:

```bash
./scripts/build_web_player.sh
```

Default expected path in this repo: `modules/libmoonsound`.

If needed, point to a different location explicitly:

```bash
LIBMOONSOUND_DIR=/path/to/libmoonsound ./scripts/build_web_player.sh
```

This does:

1. Builds `libmoonsound` with Emscripten in `build-emscripten-libmoonsound/`
2. Links `web/player/dmv_player_bridge.c` with `libmoonsound.a`
3. Writes `web/player/moonsound.js` and `web/player/moonsound.wasm`
4. Copies `yrw801.rom` and `waves.dat` into `web/assets/`

## Run Locally

From repository root:

```bash
python3 -m http.server 8080
```

Open:

- [http://localhost:8080/web/](http://localhost:8080/web/)

## Notes

- Two menu entries on `DMV3` reference files not found on disk (`TAKETIME.MWM`, `LALALA.MWM`). They are shown as unavailable.
- Browser audio starts only after user interaction (`Play`) due autoplay policies.

## GitHub Pages CI

Workflow file: `.github/workflows/pages.yml`

- Builds catalog + WASM on GitHub Actions
- Publishes `web/` + `DMV1..DMVFT` + `DMVMENU.BIN` to GitHub Pages

Requirement for CI:

- `libmoonsound` must exist at `./modules/libmoonsound` in GitHub (as a submodule).
