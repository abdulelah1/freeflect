<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/freeflect-lockup-on-dark.svg">
  <img src="docs/brand/freeflect-lockup.svg" alt="FreeFlect" height="44">
</picture>

# FreeFlect

See and control your phone on your computer. FreeFlect shows a live, sharp picture of an Android phone or an iPhone on your Mac, and lets you drive Android phones with your mouse and keyboard.

FreeFlect is a desktop app for macOS, downloaded from the Releases page (not the Mac App Store), with a small companion app for iPhone that the desktop app installs for you. It works in English and Arabic.

## What it does

| | Android | iPhone |
|---|---|---|
| Live mirror over a cable or Wi-Fi, full screen, in its own window, cropped | Yes | Yes |
| Control with mouse and keyboard | Yes | Cable only, a developer feature |
| Screenshots, recordings with sound, animated GIFs | Yes | Yes |
| Phone sound on the computer | Yes | Yes |
| Files both ways, drag photos and files off the phone | Yes | Yes |
| Shared clipboard | Yes | Through the iPhone app |
| Several phones at once, one action sent to all | Yes | Yes |
| Step-by-step setup and a Connection Doctor | Yes | Yes |
| Developer tools: logs, apps, device stats | Yes | |

Phones connect directly to your computer. Nothing goes through a server.

## Install

1. Download the DMG for your Mac (Apple Silicon or Intel) from the Releases page.
2. Open it and drag FreeFlect to Applications.
3. The first time, macOS says it can't verify the app. Open System Settings, Privacy & Security, and click **Open Anyway** next to FreeFlect.
4. FreeFlect opens its setup guide. Pick Android or iPhone and follow the steps.

**Android:** the guide shows how to turn on Developer options and USB debugging for your phone's brand. Wi-Fi works with Android 11 or later.

**iPhone:** plug it in and tap Trust to mirror over the cable. For Wi-Fi, the clipboard and files, install the FreeFlect iPhone app from Settings, FreeFlect iPhone app. FreeFlect builds it with your own Apple ID in Xcode or a provisioning profile you have; nothing is tied to the project's authors. A free Apple ID works, but then the app has to be installed again every 7 days.

## Build from source

Requirements: macOS, Node 20+, pnpm 10, Rust (stable), a JDK, the Android SDK (platform 36 and build tools), Xcode, and XcodeGen (`brew install xcodegen`).

```sh
pnpm install
pnpm dev            # builds the native parts and runs the app with hot reload
pnpm test           # Rust and JavaScript tests
pnpm release:mac    # builds the DMG into release/dist
```

## Project layout

| Path | What |
|---|---|
| `apps/desktop` | Electron + React app (main process, preload, window) |
| `apps/desktop/src/locales` | Translations, one JSON file per language |
| `crates/core` | Shared types: sessions, input events, errors |
| `crates/media` | H.264 parsing and MP4 recording |
| `crates/android` | adb client, phone server launcher, control messages |
| `crates/ios` | iPhone capture, usbmux, lockdown and AFC (photos) |
| `crates/companion` | Local-network server for the iPhone app |
| `crates/node-bindings` | Native addon (napi-rs) used by the desktop app |
| `android-server` | Java server that runs on the phone: screen, sound, input |
| `native/macos/ios-capture` | Swift helper that captures a USB iPhone's screen and sound |
| `native/ios/MirrorCompanion` | iPhone companion app (XcodeGen project) |
| `native/shared` | Swift code shared by the helper and the iPhone app |

## Documentation

- [Contributing](CONTRIBUTING.md): setup, conventions, testing
- [Wire protocol](docs/protocol.md): how the phone and the desktop talk
- [Releasing](docs/release.md): building the DMG, signing, the iPhone app
- [Adding a language](docs/localization.md)
