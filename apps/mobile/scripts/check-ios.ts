// Compile-checks the iOS side without an installed iOS platform/simulator runtime:
//   1. `swift build` of ios/App/CapApp-SPM (Capacitor + every plugin) for arm64 iOS Simulator
//   2. `swiftc -typecheck` of the App target's sources (AppDelegate, SceneDelegate) against it
// This is what `xcodebuild` would compile, minus linking/packaging the .app, which needs the
// iOS platform component (see README: `xcodebuild -downloadPlatform iOS`).

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const spmDir = join(appDir, 'ios', 'App', 'CapApp-SPM');
const scratch = join(appDir, 'ios', 'DerivedData', 'spm-check');
const resolved = join(spmDir, 'Package.resolved');
const triple = 'arm64-apple-ios15.0-simulator';

const sdk = execFileSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' }).trim();
const hadResolved = existsSync(resolved);
try {
  execFileSync('swift', ['build', '--package-path', spmDir, '--scratch-path', scratch, '--triple', triple, '--sdk', sdk], { stdio: 'inherit' });
} finally {
  // The app's pins live in App.xcodeproj/.../swiftpm/Package.resolved; don't leave a second copy.
  if (!hadResolved) rmSync(resolved, { force: true });
}
const products = join(scratch, 'arm64-apple-ios-simulator', 'debug');
execFileSync(
  'xcrun',
  ['--sdk', 'iphonesimulator', 'swiftc', '-typecheck', '-target', triple, '-sdk', sdk, '-F', products, '-I', join(products, 'Modules'),
    join(appDir, 'ios/App/App/AppDelegate.swift'), join(appDir, 'ios/App/App/SceneDelegate.swift')],
  { stdio: 'inherit' },
);
console.log('iOS sources compile for the simulator (plugins built, App target type-checked).');
