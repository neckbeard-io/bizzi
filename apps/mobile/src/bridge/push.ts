// Push notifications: SCAFFOLD ONLY, off by default.
//
// Enabled by staging with BIZZI_PUSH=1 (see scripts/stage.ts), which needs, before it can work:
//   iOS:     an Apple developer account, the Push Notifications capability + aps-environment
//            entitlement on the App target, and an APNs key on the hub.
//   Android: a Firebase project and android/app/google-services.json (FCM), or a UnifiedPush
//            distributor (ntfy) through a UnifiedPush plugin instead of FCM. See README "Push".
// Without those, calling register() fails (iOS) or throws on missing Firebase (Android), which
// is why it is behind a build flag.
//
// When a token arrives the bridge stores it on `bizziNative.push.token` and dispatches a
// `bizzi:push-token` window event ({ detail: { platform, token } }). Sending it to the hub
// (a future `push.register` method) is the UI's job.

export const PUSH_TOKEN_EVENT = 'bizzi:push-token';

/** Minimal shape of `@capacitor/push-notifications` used here. */
export interface PushPlugin {
  checkPermissions(): Promise<{ receive: string }>;
  requestPermissions(): Promise<{ receive: string }>;
  register(): Promise<void>;
  addListener(event: 'registration', cb: (t: { value: string }) => void): Promise<unknown>;
  addListener(event: 'registrationError', cb: (e: { error: string }) => void): Promise<unknown>;
}

export interface PushState {
  enabled: boolean;
  token: string | null;
}

export interface PushDeps {
  plugin: PushPlugin;
  state: PushState;
  onToken(token: string): void;
  onError(message: string): void;
}

/** Ask for permission (once) and register with APNs/FCM. Returns false if permission is denied. */
export async function registerPush(deps: PushDeps): Promise<boolean> {
  const { plugin, state } = deps;
  await plugin.addListener('registration', (t) => {
    state.token = t.value;
    deps.onToken(t.value);
  });
  await plugin.addListener('registrationError', (e) => deps.onError(e.error));

  let perm = await plugin.checkPermissions();
  if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await plugin.requestPermissions();
  if (perm.receive !== 'granted') return false;
  await plugin.register();
  return true;
}
