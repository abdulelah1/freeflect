# Releasing FreeFlect

FreeFlect for macOS ships as a DMG on the GitHub Releases page. It is not on the
Mac App Store. The FreeFlect iPhone app is not on the App Store either: the desktop
app builds it and installs it on the user's iPhone (see below).

## Making a release

1. Set the version in `apps/desktop/package.json` (for example `0.2.0`) and commit.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. The **Release** workflow (`.github/workflows/release.yml`) builds an Apple
   Silicon and an Intel DMG and attaches them to a **draft** release.
4. Check the draft, write the notes, and publish it.

The app checks the releases page once a day and offers new versions. Set the
repository in `apps/desktop/package.json`:

```json
"mirror": { "releasesRepo": "owner/repo" }
```

While it is empty, the update check stays off.

### Building locally

```sh
source ~/.cargo/env
pnpm release:mac        # release/dist/FreeFlect-<version>-<arch>.dmg
```

Needs Rust, Node 20 and pnpm, Xcode, XcodeGen (`brew install xcodegen`), a JDK and
the Android SDK (platform 36 and build tools). `scripts/prepare-release.sh`
builds every part and stages it in `release/staging`:

| Staged | In the app (`Contents/Resources`) |
|---|---|
| Native addon (`mirror-native.darwin-<arch>.node`) | `native/` |
| Android phone server | `mirror-server.jar` |
| iPhone screen capture helper | `ios-capture` |
| adb, from the Android SDK or Google's platform-tools download | `platform-tools/adb` |
| FreeFlect iPhone app project, with its generated Xcode project | `companion/native/...` |

## Signing

The DMG is signed **ad hoc**: it runs on Apple Silicon, but macOS doesn't know
the developer, so the first launch is blocked. Tell users:

1. Drag FreeFlect to Applications and open it. macOS says it can't verify the app.
2. Open System Settings, Privacy & Security, scroll down, and click
   **Open Anyway** next to FreeFlect. Confirm with your password.

To remove the warning, sign with a **Developer ID Application** certificate
(needs a paid Apple Developer Program membership) and notarize. electron-builder
does both when given the certificate and Apple credentials (`CSC_LINK`,
`CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`)
with `mac.identity` set to the certificate and `hardenedRuntime` turned on.

Self-updating needs a Developer ID signature too, so for now the app only
tells users about new versions and opens the release page.

## The FreeFlect iPhone app

FreeFlect is open source, so the project holds no signing team or account.
Everyone signs the iPhone app with their own. In Settings, FreeFlect iPhone app,
**Install on an iPhone** (also in the setup wizard), the user chooses how:

- **Apple ID in Xcode:** pick a team from the Apple IDs added in Xcode
  (Settings, Accounts). Xcode creates the profiles itself
  (`xcodebuild -allowProvisioningUpdates`). A free Apple ID works; its app stops
  opening after 7 days and the iPhone must trust the developer once (Settings,
  General, VPN & Device Management).
- **Provisioning profile:** pick one of the profiles installed on the Mac
  (`~/Library/Developer/Xcode/UserData/Provisioning Profiles` and
  `~/Library/MobileDevice/Provisioning Profiles`). It needs App IDs for
  `com.freeflect.ios`, `com.freeflect.ios.broadcast` and
  `com.freeflect.ios.share`, or a wildcard (`com.freeflect.*`, `*`). A wildcard
  that doesn't cover them (`com.you.*`) builds as `com.you.freeflect.ios`; an
  explicit profile for another id builds as that id, with its `.broadcast` and
  `.share` profiles found among the installed ones. The profile must include the
  iPhone (or be an enterprise profile), and its certificate must be in the
  keychain. The build uses manual signing (`CODE_SIGN_STYLE=Manual`,
  `FF_PROFILE_APP/BROADCAST/SHARE=<uuid>`).

Nothing is chosen for the user. When there is no Apple ID or no profile, the
installer shows the steps to add one. The last choice is remembered.

The installer copies the bundled project to its profile folder, builds it for
the choice, installs it with `devicectl` and opens it. The bundle id is
`com.freeflect.ios` (extensions `.broadcast` and `.share`). Apple keeps bundle
ids unique across accounts, so when another team has already registered it,
the installer builds again as `com.freeflect.ios.t<team id>` and says so.

Requirements on the user's Mac: Xcode (opened once). On the iPhone: Developer
Mode (Settings, Privacy & Security) and the cable for the install.
