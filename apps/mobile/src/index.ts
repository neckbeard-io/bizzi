// Public surface of @bizzi/mobile: the `window.bizziNative` contract and the pure deep-link helpers.
// (The bridge itself ships as www/native-bridge.js; see src/bridge/install.ts.)

export type { BizziNative, BizziNativeBridge, BizziNativeExtras, NativePlatform } from './bridge/bridge.ts';
export type { PairLink } from './bridge/deeplink.ts';
export { DEEP_LINK_SCHEME, PAIR_EVENT, parsePairLink } from './bridge/deeplink.ts';
export { PUSH_TOKEN_EVENT } from './bridge/push.ts';
