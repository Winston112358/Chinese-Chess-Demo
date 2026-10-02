# Bundled Pikafish resources

This directory contains the resources for local, offline Windows x64 play. Run
`npm run setup:ai` from the project root to download and verify missing files.
The engine executable, NNUE weights and source archive are deliberately ignored
by Git; the manifest and the original upstream license/attribution files are tracked.

- Upstream release: [Pikafish-2026-09-06](https://github.com/official-pikafish/Pikafish/releases/tag/Pikafish-2026-09-06).
- Upstream executable: `Pikafish-Windows-x86-64-universal.exe`, renamed to `pikafish.exe` without modifying its bytes.
- Corresponding source tag: `Pikafish-2026-09-06`, commit `4c17cee11f888ae1d48a9494f2e2239f019f0a1f`.
- Corresponding source: [fixed tag archive](https://github.com/official-pikafish/Pikafish/archive/refs/tags/Pikafish-2026-09-06.zip), also bundled here as `Pikafish-source-Pikafish-2026-09-06.zip`.
- Release URL, file sizes and SHA-256 checksums are recorded in [manifest.json](manifest.json).

`Copying.txt` is the engine's GPLv3 license. `AUTHORS` and `UPSTREAM-README.md`
are copied unchanged from the official distribution. The source ZIP includes the
engine source, Makefile, build workflows and upstream compilation instructions.
The engine is run as a separate process over UCI; this project does not modify it.

`NNUE-License.md` applies separately to `pikafish.nnue`. In particular, no
commercial use is permitted without permission. This app currently bundles the
weights for personal, noncommercial use. Do not discard either license or the
source archive when redistributing the bundled engine.

`npm run dist:win` first verifies/prepares this directory, then electron-builder
copies it to `resources/pikafish` outside `app.asar`. No account, API key, network
connection, or GPU is needed during play. The model is already trained.
