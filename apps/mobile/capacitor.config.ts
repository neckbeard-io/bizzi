// Capacitor config for the bizzi phone app. Loaded by the Capacitor CLI (Node strips the types).
//
// The phone is a client only: it loads the bundled UI from www/ (a staged copy of
// packages/ui/dist plus native-bridge.js, see scripts/stage.ts) and talks to the user's hub over
// wss://. Nothing here points at a server.
//
// BIZZI_DEV_CLEARTEXT=1 (at `cap sync` time) allows a plain http/ws hub on the LAN for development:
// Android cleartext traffic + mixed content. Off by default; iOS needs a separate ATS exception
// (see README "LAN hub over http").

import type { CapacitorConfig } from '@capacitor/cli';

const devCleartext = process.env['BIZZI_DEV_CLEARTEXT'] === '1';

const config: CapacitorConfig = {
  appId: 'dev.bizzi.app',
  appName: 'bizzi',
  webDir: 'www',
  // Bridge/console logging in debug builds only.
  loggingBehavior: 'debug',
  server: {
    // Origins the hub sees: https://localhost (Android), capacitor://localhost (iOS).
    androidScheme: 'https',
    iosScheme: 'capacitor',
    ...(devCleartext ? { cleartext: true } : {}),
  },
  ios: {
    // The UI handles safe areas itself (viewport-fit=cover + env(safe-area-inset-*)).
    contentInset: 'never',
  },
  android: {
    // Lets an https://localhost page open ws:// sockets. Development only (BIZZI_DEV_CLEARTEXT=1).
    allowMixedContent: devCleartext,
  },
  plugins: {
    SystemBars: {
      // Inject --safe-area-inset-* CSS vars for older Android WebViews, env() works on newer ones.
      insetsHandling: 'css',
      initialViewportFitValueHint: 'cover',
      style: 'DEFAULT',
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
