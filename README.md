# Nako Portal

A private, passkey-protected portal for Hermes. Create and continue portal-native chats, inspect external sessions in read-only mode, and manage the gateway from the web, desktop or Android app.

## Architecture

- `plugin.yaml` and `__init__.py` register the Hermes plugin and its portal messaging platform. The gateway adapter connects to a separate local portal server.
- `dashboard/portal/` contains the Python HTTP/WebSocket server, authentication, storage and gateway link. `web/` contains the React/TypeScript UI; its production build is served from `dashboard/web/`.
- `desktop/` is an Electron shell with browser sign-in, notifications, a floating companion and signed updates. Linux AppImage and Windows builds update from the portal; the macOS app updates through Homebrew.
- `android/` is a Kotlin WebView shell with a direct alert socket, an optional bubble and APK updates.

The shells load the portal's web app from the configured server. UI deployments do not require rebuilding the native shells.

## Local development

Install this checkout as the `nako-portal` plugin in your Hermes environment. Configure `plugins.entries.nako-portal.settings.origin` with the portal's externally reachable HTTPS origin, then restart the Hermes gateway. Set up a passkey in the portal before signing in from another device. The gateway starts the portal server; the native apps connect to its origin, not to a bundled development server.

For desktop development, use a current Node.js/npm supported by the dependencies:

```sh
npm --prefix desktop ci
npm --prefix desktop start
```

For Android, install JDK 21 and an Android SDK with API 37 and the required build tools, and set `ANDROID_HOME`:

```sh
cd android
./gradlew assembleDebug
```

The debug APK is under `android/app/build/outputs/apk/debug/`. Enter the same portal origin in either shell. Web UI changes can be built with `npm --prefix web ci && npm --prefix web run build`.

## Tests

Desktop behavior tests run in Node without starting Electron:

```sh
npm --prefix desktop ci --ignore-scripts
npm --prefix desktop test
```

`--ignore-scripts` skips the Electron binary download, so use a normal install when launching the app. Android unit tests and lint require the Android toolchain:

```sh
cd android
./gradlew testDebugUnitTest lintDebug
```

Check release-script syntax with `bash -n release.sh desktop/release.sh android/release.sh`. Native window, notification, WebView and installer behavior should also be exercised on the target OS/device before release.

## Releases

Release scripts require GitHub CLI authentication and a clean checkout. The root script fetches `origin/main` and builds in a temporary worktree:

```sh
./release.sh                 # desktop and Android, next patch versions
./release.sh desktop         # desktop only
./release.sh android 1.2.3    # explicit version for one app
```

Version selection scans all published GitHub releases. Android uses one more than the maximum published APK version code. Direct `desktop/release.sh <version>` and `android/release.sh <version>` commands build the current clean checkout; publication requires that commit to be on `origin/main`. `DRY_RUN=1` builds and keeps artifacts without publishing, but still needs build tools and signing credentials.

Desktop releases need Node/npm, Docker for the Windows installer, and the existing minisign-compatible updater key: `TAURI_SIGNING_PRIVATE_KEY` plus `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, or `NAKO_UPDATER_KEY` (default `~/.config/nako-desktop/updater.key`) with a `.password` companion. `@tauri-apps/cli` remains the signing tool, and `__TAURI_INTERNALS__` remains a bridge for older portal bundles.

Android releases need the SDK/JDK and `PORTAL_ANDROID_KEYSTORE` (default `~/.config/hermes-portal/android-release.jks`). The password defaults to the adjacent `.password` file; `PORTAL_ANDROID_KEY_PASSWORD` defaults to that password and `PORTAL_ANDROID_KEY_ALIAS` to `hermes`.

Desktop publication also updates `QuillDev/homebrew-tap`; `NAKO_TAP` overrides the repository or `NAKO_TAP=none` skips it. A tap failure after publication prints a warning and lets a combined release proceed to Android. Recover without another build or release:

```sh
desktop/release.sh 1.2.3 --sync-tap
```

Repeating an already published desktop version also retries only the tap. Synchronization is a no-op when current and refuses to downgrade a newer formula or overwrite an unexpected formula/checksum. Linux/Windows assets and `desktop-release.json`, or the APK and `android-release.json`, are published under separate `desktop-v*` and `android-v*` tags.
