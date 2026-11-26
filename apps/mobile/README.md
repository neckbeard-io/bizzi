# @bizzi/mobile

The bizzi phone app: a Capacitor 8 shell around the shared React UI (`packages/ui`). The phone is a
**client only**. It loads the bundled UI from the app package and talks to your self-hosted hub
over `wss://`. Nothing runs on the phone except the UI and a small native bridge.

```
apps/mobile/
  capacitor.config.ts     appId dev.bizzi.app, webDir www/ (staged UI), schemes, SystemBars, push opts
  src/bridge/             window.bizziNative (TS, bundled by esbuild into www/native-bridge.js)
    install.ts            entry: wires the plugins, deep links, system bars, push stub
    bridge.ts             the contract + createBizziNative() (pure, unit-tested)
    deeplink.ts           bizzi://pair parsing + pending-link inbox (pure)
    theme.ts  push.ts     status-bar style from data-theme; push registration stub
  scripts/
    stage.ts              packages/ui/dist -> www/ + native-bridge.js + <script> injection
    inject.ts             the index.html rewrite (pure)
    bundle-bridge.ts      esbuild IIFE bundle of src/bridge/install.ts
    check-ios.ts          compile check of the iOS side without a simulator runtime
    icons.ts              placeholder icon (resources/icon.png, iOS AppIcon, Android mipmaps)
  ios/                    Xcode project (Swift Package Manager, no CocoaPods)
  android/                Gradle project
  test/                   node:test
```

`packages/ui` is never modified. The stage step copies its build and injects
`<script src="./native-bridge.js">` as the first script in `<head>`, so `window.bizziNative` exists
before any UI code runs.

## Plugins

| Need | Plugin | Why this one |
|---|---|---|
| Secure storage | `@aparajita/capacitor-secure-storage` 8.x | Capacitor 8 release with Swift Package Manager support. iOS Keychain with selectable accessibility (we use `afterFirstUnlockThisDeviceOnly`, no iCloud sync). Android: AES-GCM key in the Android Keystore. `getItem` returns `null` for missing keys. `capacitor-secure-storage-plugin` (0.13) also supports Capacitor 8, but it uses the unmaintained SwiftKeychainWrapper, an older RSA-based Android helper, and it throws on missing keys. `@capgo/capacitor-native-biometric` stores biometric-gated username/password credentials per server, not generic key/value data. |
| QR scanning | `@capacitor/barcode-scanner` 3.x (Ionic) | Official, Capacitor 8, **ships a Package.swift**, full-screen native scanner UI on both platforms, ML Kit (bundled model, works without Google Play services) or ZXing on Android. `@capacitor-mlkit/barcode-scanning` has **no Package.swift**: iOS needs CocoaPods (GoogleMLKit), which this setup avoids. |
| Deep links | `@capacitor/app` | `appUrlOpen` + `getLaunchUrl()` |
| Status bar / safe areas | Capacitor 8 core `SystemBars` | Built in, so `@capacitor/status-bar` isn't needed |
| Push (scaffold) | `@capacitor/push-notifications` | APNs on iOS, FCM on Android; off by default (see Push) |

The bridge talks to the scanner through `registerPlugin('CapacitorBarcodeScanner')` with inlined
constants, so the bundle doesn't include the plugin's web fallback (html5-qrcode). The bundle is
about 18 KB.

## Prerequisites

- Node ≥ 26, npm 11 (repo root `npm install`)
- **iOS:** macOS with Xcode 26+, **plus the iOS platform / simulator runtime**:
  ```sh
  xcodebuild -downloadPlatform iOS        # or Xcode > Settings > Components > iOS 26.x
  ```
  No CocoaPods: the project uses Swift Package Manager (`ios/App/CapApp-SPM`, pins in
  `App.xcodeproj/.../swiftpm/Package.resolved`). The first build fetches capacitor-swift-pm,
  keychain-swift and OSBarcodeLib-iOS from GitHub. A device build needs an Apple ID / team for
  signing (a free account works for personal devices).
- **Android:** JDK 21 (Capacitor 8 compiles Java 21) and the Android SDK with
  `platforms;android-36`, `build-tools;36.x` and `platform-tools`. The easiest path is Android Studio
  (it bundles a JDK 21). On the command line:
  ```sh
  export JAVA_HOME=/path/to/jdk-21
  export ANDROID_HOME=$HOME/Library/Android/sdk      # Linux: $HOME/Android/Sdk
  sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
  ```
  Gradle 8.14.3 is fetched by the wrapper and AGP is 8.13. `minSdk` is 26 (required by the scanner)
  and `targetSdk` is 36.

## Build

```sh
npm run build -w @bizzi/mobile        # build:ui (vite) -> stage (www/ + bridge) -> cap sync
```

Individual steps: `build:ui`, `stage` (`--sourcemaps` keeps `.map` files, `BIZZI_PUSH=1` compiles in
the push stub) and `sync` (`cap sync`, which copies www/ into both native projects and updates the
plugin lists). `www/`, `ios/App/App/public`, `android/app/src/main/assets/public`, the generated
`capacitor.config.json` files and all build outputs are gitignored.

### iOS

```sh
npm run build:ios:sim -w @bizzi/mobile   # xcodebuild, generic iOS Simulator, no signing
npm run run:ios -w @bizzi/mobile         # cap run ios: pick a simulator or a connected device
npm run open:ios -w @bizzi/mobile        # open in Xcode (set your Team under Signing for devices)
npm run check:ios -w @bizzi/mobile       # compile check without the simulator runtime (see below)
```

On a device: open the project in Xcode, select the App target, then Signing & Capabilities, choose
your team, select the phone and Run. TestFlight needs a paid developer account.

### Android

```sh
npm run build:android -w @bizzi/mobile   # ./gradlew assembleDebug
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
npm run run:android -w @bizzi/mobile     # cap run android: emulator or USB device (USB debugging on)
npm run open:android -w @bizzi/mobile    # Android Studio
```

Release: `cd android && ./gradlew bundleRelease` with your own keystore configured in
`android/app/build.gradle` (`signingConfigs`). Keystores are never committed.

### What was built on the authoring machine (macOS, Xcode 26.3, no simulator runtime, no Android SDK/JDK)

- UI build, stage, `cap add ios`, `cap add android`, `cap sync`: OK.
- `npm run check:ios`: OK. `swift build` of CapApp-SPM for `arm64-apple-ios15.0-simulator`
  compiles Capacitor 8.6.0 and all four plugins, and the App target's Swift sources type-check against
  them.
- `npm run build:ios:sim` fails before compiling, because the iOS platform component isn't installed:
  ```
  xcodebuild: error: Unable to find a destination matching the provided destination specifier:
          { generic:1, platform:iOS Simulator }
      Ineligible destinations for the "App" scheme:
          { platform:iOS, id:dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder, name:Any iOS Device,
            error:iOS 26.2 is not installed. Please download and install the platform from Xcode > Settings > Components. }
  ```
  Fix: `xcodebuild -downloadPlatform iOS`, then re-run `npm run build:ios:sim`.
- `npm run build:android`: `The operation couldn’t be completed. Unable to locate a Java Runtime.`
  Install JDK 21 and the Android SDK as described above.

## The native bridge: `window.bizziNative`

Only present inside the native app (`Capacitor.getPlatform()` is `ios` or `android`). In a browser the
script does nothing, so the UI can feature-detect with `if (window.bizziNative)`.

```ts
interface BizziNative {
  platform: 'ios' | 'android';
  secureGet(key: string): Promise<string | null>;   // null if missing
  secureSet(key: string, value: string): Promise<void>;
  secureDelete(key: string): Promise<void>;          // no error if missing
  scanQr(): Promise<string | null>;                  // scanned text, or null if canceled
}

// Extras (feature-detect each one):
interface BizziNativeExtras {
  version: string;                                   // bridge version (package.json)
  takePairLink(): { url: string; hub: string; code: string } | null;  // see deep links
  parsePairLink(text: string): { url: string; hub: string; code: string } | null;
  push: { enabled: boolean; token: string | null };  // scaffold, see Push
}
```

The types are exported from `@bizzi/mobile` (`src/index.ts`) for reference. The UI should declare
its own copy rather than depend on this app.

- **Secure storage.** Keys are non-empty strings of at most 256 chars, values are strings (JSON-encode
  objects). Entries are stored as `bizzi_<key>` in the iOS Keychain (`afterFirstUnlockThisDeviceOnly`:
  readable in the background after first unlock, never synced or restored to another device) and
  encrypted with an Android Keystore AES-GCM key (`allowBackup=false`). This matches D8: the device
  keypair belongs to this device. **Suggested use:** keep the device's Ed25519 private key (export as
  JWK or PKCS#8) and `deviceId` here rather than in `localStorage`. WebCrypto Ed25519 is available in
  recent WebViews (WebKit on iOS 17+, Chromium 137+). Feature-detect it and fall back to a JS
  implementation if needed.
- **scanQr()** opens a full-screen native scanner (QR only, back camera) and resolves with the text.
  Canceling resolves `null`. A denied camera permission rejects with
  `Error('Camera access was denied. …')`, so offer manual code entry as the fallback. The first call
  shows the OS camera prompt.

## Deep links: `bizzi://pair?hub=…&code=…`

Registered on iOS (`CFBundleURLTypes`, scheme `bizzi`) and Android (VIEW/BROWSABLE intent filter,
scheme `bizzi`, host `pair`).

- `hub`: URL-encoded hub base URL, `https://`, `wss://`, `http://` or `ws://` (no credentials).
- `code`: the one-time pairing code (letters, digits, dashes, spaces; ≤ 128 chars). Normalize it
  with `normalizePairingCode` from `@bizzi/protocol` before `POST /api/pair`.

Anything else (other routes, bad hub URLs, other schemes) is ignored.

**Contract for the UI.** When a pairing link opens the app, the bridge dispatches a cancelable
window event:

```ts
window.addEventListener('bizzi:pair', (e) => {
  const { url, hub, code } = (e as CustomEvent<{ url: string; hub: string; code: string }>).detail;
  e.preventDefault();             // "handled": the bridge drops its pending copy
  startPairing(hub, code);
});
// On startup (cold start: the link may have arrived before the listener existed):
const pending = window.bizziNative?.takePairLink?.();
if (pending) startPairing(pending.hub, pending.code);
```

If no listener calls `preventDefault()`, the link stays pending until `takePairLink()` takes it. The
same URL reported twice within 5 s (launch URL plus `appUrlOpen` on a cold start) is delivered once.

Test it:

```sh
xcrun simctl openurl booted "bizzi://pair?hub=https%3A%2F%2Fbizzi.example.com&code=AB12-CD34"
adb shell am start -W -a android.intent.action.VIEW \
  -d "bizzi://pair?hub=https%3A%2F%2Fbizzi.example.com&code=AB12-CD34" dev.bizzi.app
```

## How pairing works on the phone

1. On an already-paired device (for example the desktop app), open **Pair new device**. It calls
   `pairing.create` and shows a QR code of the pairing URL. For the very first device, use the
   hub's setup code (hub log or `<dataDir>/setup-code`).
2. On the phone, either:
   - tap **Scan QR** in the UI, which calls `bizziNative.scanQr()` and then `bizziNative.parsePairLink(text)`
     (or the UI's own parser if the hub's `pairUrl` uses a different form), or
   - open the `bizzi://pair?…` link on the phone (from a message, mail or a tap), which delivers it via
     `bizzi:pair` / `takePairLink()`, or
   - type the hub URL and code by hand.
3. The UI generates an Ed25519 keypair, `POST {hub}/api/pair` with the code and public key, stores
   the private key and `deviceId` with `secureSet`, then gets tokens via `/api/auth/challenge` and
   `/api/auth/token` and connects to `clientUrl` (`wss://…/ws`).

**For the hub:** requests from the app come from origin `capacitor://localhost` (iOS) and
`https://localhost` (Android). The hub must accept these `Origin`s on the WebSocket upgrade and answer
CORS for `/api/pair` and `/api/auth/*`. Alternatively, set `plugins.CapacitorHttp.enabled: true` here to
route `fetch` through native HTTP, which skips CORS (WebSockets are unaffected).

## Networking

The default is HTTPS/WSS only. iOS App Transport Security stays on with no exceptions, Android
cleartext is off, and so is mixed content. A hub behind Caddy or another TLS proxy (D8) works with no
changes. `NSLocalNetworkUsageDescription` is set, because iOS asks before the app talks to a hub on
the LAN.

### LAN hub over plain http/ws (development only)

Android: sync with the flag, which turns on `server.cleartext` (`usesCleartextTraffic`) and
`android.allowMixedContent` (the page is `https://localhost`, the socket is `ws://`):

```sh
BIZZI_DEV_CLEARTEXT=1 npm run sync -w @bizzi/mobile     # plain `npm run sync` turns it off again
```

iOS: add an ATS exception to `ios/App/App/Info.plist` locally, and don't commit it:

```sh
/usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity dict" \
  -c "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true" ios/App/App/Info.plist
# If the web view still refuses ws:// to your host, also allow it for web content (dev only):
/usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity:NSAllowsArbitraryLoadsInWebContent bool true" ios/App/App/Info.plist
# Undo:
/usr/libexec/PlistBuddy -c "Delete :NSAppTransportSecurity" ios/App/App/Info.plist
```

## Status bar and safe areas

The UI uses `viewport-fit=cover` and draws edge to edge. iOS uses `contentInset: 'never'`, so the
UI's `env(safe-area-inset-*)` padding applies. On Android, Capacitor 8's `SystemBars` with
`insetsHandling: 'css'` makes `env()` work on Chromium ≥ 140 and injects `--safe-area-inset-*` CSS
variables for older WebViews. The UI can use `var(--safe-area-inset-top, env(safe-area-inset-top))`.
The bridge watches `<html data-theme>` and switches the bar icons: `dark` gives light icons, `light`
gives dark icons.

## App icon

`npm run icons -w @bizzi/mobile` draws a placeholder (a white "b" on #5B3DF5) into
`resources/icon.png`, the iOS AppIcon and the Android mipmaps (legacy, round and adaptive
foreground). For a real design, replace `resources/icon.png` (1024×1024) and run
`npx @capacitor/assets generate`.

## Push (scaffold, off by default)

D9: APNs on iOS, ntfy/UnifiedPush and/or FCM on Android. What's in place:

- `@capacitor/push-notifications` is installed. `AppDelegate.swift` forwards the APNs token, the
  Android manifest declares `POST_NOTIFICATIONS`, and `android/app/build.gradle` applies the
  google-services plugin only if `android/app/google-services.json` exists.
- `src/bridge/push.ts` handles permission, then `register()`. The token goes to `bizziNative.push.token`
  and a `bizzi:push-token` window event (`detail: { platform, token }`). It is compiled in only with
  `BIZZI_PUSH=1 npm run stage`. Sending the token to the hub needs a hub method that doesn't exist
  yet (for example `push.register { platform, token | endpoint }`).

Turning it on:

- **iOS (APNs):** paid Apple developer account. Add the *Push Notifications* capability to the App
  target (this creates `App.entitlements` with `aps-environment`) and create an APNs auth key (.p8).
  The hub then sends directly to APNs over HTTP/2 with that key. No Firebase is needed on iOS.
- **Android, FCM:** create a Firebase project, put `google-services.json` in `android/app/`, and
  give the hub an FCM service account. This is simple, but it goes through Google.
- **Android, UnifiedPush + ntfy (self-hosted, preferred for bizzi):** the user runs ntfy (or uses
  ntfy.sh) and installs the ntfy Android app as the UnifiedPush *distributor*. bizzi registers with
  the distributor through `org.unifiedpush.android:connector` and receives an endpoint URL, which
  it sends to the hub. The hub POSTs RFC 8291 Web Push-encrypted messages to that endpoint. No
  Google services are involved. There is no maintained Capacitor plugin for this yet, so the plan is
  a small in-app Capacitor plugin (Kotlin) that wraps the connector and reuses the same
  `bizzi:push-token` event (with an endpoint instead of a token).
- **Actionable notifications (spec §11):** Approve/Deny buttons through notification categories
  (iOS `UNNotificationCategory`, Android notification actions). The action is delivered by
  `pushNotificationActionPerformed` and forwarded to the UI as an event.

## Tests

```sh
npm test -w @bizzi/mobile        # node:test: deep links, bridge, staging/injection, the bundle in a VM
                                 # against a fake Capacitor runtime, config + native project checks
npm run typecheck -w @bizzi/mobile
```
