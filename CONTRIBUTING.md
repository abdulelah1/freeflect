# Contributing to FreeFlect

Thanks for helping. This guide covers setting up, the conventions the code follows, and how changes are tested.

## Set up

Requirements: macOS, Node 20+, pnpm 10, Rust (stable), a JDK, the Android SDK (platform 36 and build tools, `ANDROID_HOME` set), Xcode, XcodeGen (`brew install xcodegen`), and ffmpeg for the test video.

```sh
pnpm install
node apps/desktop/node_modules/electron/install.js   # only if Electron's binary did not download
pnpm spike:fixture       # creates fixtures/sample-1080p60.h264 for the Test stream
pnpm dev                 # builds the native addon, phone server and iPhone helper, then runs the app
```

If a build seems to do nothing, make sure Rust is on your PATH (`source ~/.cargo/env`).

The iPhone companion app is an XcodeGen project: run `xcodegen generate` in `native/ios/MirrorCompanion` to create `MirrorCompanion.xcodeproj`, or install it from the running app (Settings, FreeFlect iPhone app).

## How the pieces fit

- The Electron **main process** (`apps/desktop/src/main`) owns phones, files and settings. The **window** (`apps/desktop/src/renderer`) is React and talks to it only through the typed API in `src/shared-ipc.ts` and `src/preload`.
- Phone protocols live in **Rust** (`crates/*`) and reach Node through the napi-rs addon in `crates/node-bindings`.
- The **Android server** (`android-server`) runs on the phone; the **iPhone helper** (`native/macos/ios-capture`) and **companion app** (`native/ios`) are Swift.
- The phone-to-desktop format is in `docs/protocol.md`. Change it there first.

## Conventions

**General**
- Match the surrounding code: its naming, comment density and idioms.
- Comments explain why, not what. Keep them short.

**User-facing text**
- Plain, specific words a non-technical person understands. Say what to do next.
- No em dashes. Use a period, a comma or a colon.
- Every string goes through translations: add the key to `en.json` **and** every other file in `apps/desktop/src/locales` (see `docs/localization.md`). In Swift, use `String(localized:)` or SwiftUI text and add the translation to the String Catalogs.

**UI**
- Use the existing design tokens (cobalt accent, zinc neutrals, Geist, Phosphor icons, 8 px control and 14 px panel radii). Run the `/design-taste-frontend` skill before UI work.
- Layouts must work right-to-left: use logical properties (`ms-`, `me-`, `ps-`, `pe-`, `start`, `end`) and mirror directional icons with `rtl:-scale-x-100`.
- Check light and dark themes, keyboard navigation and screen-reader labels.

**TypeScript:** strict mode; `pnpm --filter @mirror/desktop typecheck` must pass.

**Rust:** `cargo clippy --workspace --all-targets` with no warnings, and tests for protocol parsing.

**Swift:** keep the broadcast extension light (it has a 50 MB memory limit); never queue frames, drop them.

## Testing

```sh
pnpm test                                    # Rust and JavaScript tests
source ~/.cargo/env && cargo clippy --workspace --all-targets
```

The desktop app has a **smoke mode** that drives the app and exits: 0 on success. Smoke runs use their own temporary profile, so they never touch your settings or folders.

```sh
pnpm build && cd apps/desktop
MIRROR_SMOKE=/tmp/smoke.png npx electron .            # plays the Test stream, saves screenshots
```

Add any of these:

| Variable | What it does |
|---|---|
| `MIRROR_SMOKE_TARGET=android` | Mirrors the first connected phone instead of the Test stream |
| `MIRROR_SMOKE_RECORD=1` | Records a few seconds (with a phone) |
| `MIRROR_SMOKE_DEVICE_WINDOW=1` | Opens and captures the device window |
| `MIRROR_SMOKE_MULTI=<serial>` | Opens a second phone in its own window |
| `MIRROR_SMOKE_FARM=<serial>` | Opens All devices and presses Home on all |
| `MIRROR_SMOKE_FILES=<serial>`, `MIRROR_SMOKE_DEVTOOLS=1` | Exercise the side panels |
| `MIRROR_SMOKE_CROP=1` | Crops the screen and checks the cropped screenshot (with a phone) |
| `MIRROR_SMOKE_SETUP=1`, `MIRROR_SMOKE_IOS_SETUP=1` | Captures the setup wizard screens |
| `MIRROR_SMOKE_SETTINGS=1` | Captures the Settings screen |
| `MIRROR_SMOKE_DOCTOR=1` | Runs the Connection Doctor |
| `MIRROR_SMOKE_I18N=1` | Captures key screens; combine with `MIRROR_LANG=ar` |
| `MIRROR_THEME=light` or `dark` | Forces a theme |

An Android emulator works as a test phone (`emulator -avd <name> -no-window`), and keeps real phones' screens out of your screenshots.

**Privacy:** never commit screenshots, recordings or logs from a real person's phone.

## Commits and pull requests

- One topic per commit. The first line says what changed in plain words; the body says why and how it was verified.
- Before opening a pull request: tests and clippy pass, the typecheck passes, new strings are in every locale file, and UI changes were checked in light, dark and right-to-left.
- Describe how you tested it, including which phones.

## Releases

See `docs/release.md`: tag `vX.Y.Z` and the Release workflow builds the DMGs into a draft GitHub release.
