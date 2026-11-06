// A fake `claude` recipe for login tests. Only scripts in a temp dir ever run.

import { join } from 'node:path';
import { parseRecipe, RecipeSet } from '@bizzi/provision';
import { writeScript } from './helpers.ts';

export const FAKE_LOGIN_URL = 'https://auth.example.com/oauth/authorize?client_id=bizzi&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback';

/**
 * A fake `claude` recipe: its login command is a script that prints a URL and a code, marks the
 * fake agent as logged in and exits 0. Nothing real is ever run.
 */
export function fakeClaude(dir: string, loginBody: string) {
  const state = join(dir, 'logged-in');
  const bin = writeScript(
    join(dir, 'bin', 'bizzi-fake-claude'),
    `case "$1" in
  --version) echo "bizzi-fake-claude 1.0.0" ;;
  auth) if [ -f '${state}' ]; then echo '{"loggedIn":true,"email":"me@example.com"}'; else echo '{"loggedIn":false}'; exit 1; fi ;;
esac`,
  );
  const login = writeScript(join(dir, 'login.sh'), loginBody.replaceAll('$STATE', `'${state}'`));
  const device = writeScript(join(dir, 'device.sh'), 'echo "Go to https://example.com/device and enter code QRST-5678"; exit 3');
  const recipe = parseRecipe(
    `
schema: 1
name: claude
kind: agent
displayName: Fake Claude
homepage: https://example.com/fake
docs: [https://example.com/fake/docs]
verified: true
platforms:
  darwin-arm64: {}
  darwin-x64: {}
  linux-x64: {}
  linux-arm64: {}
detect:
  binaries: [bizzi-fake-claude]
  searchPaths: ["${join(dir, 'bin')}"]
  version:
    args: [--version]
    regex: 'bizzi-fake-claude (\\d+\\.\\d+\\.\\d+)'
latest:
  - type: npm
    package: "@example/fake-claude"
    verified: true
methods:
  - id: echo
    kind: script
    label: Echo
    targetDir: "${join(dir, 'bin')}"
    pinnable: false
    verified: true
    install:
      - description: Nothing
        run: "true"
    uninstall:
      - description: Nothing
        run: "true"
login:
  interactive:
    argv: ["${login}"]
    description: Fake browser login
    callbackPort: 54545
    verified: true
  headless:
    - kind: device-code
      description: Fake device code
      argv: ["${device}"]
      verified: true
auth:
  command:
    argv: [bizzi-fake-claude, auth, status]
    sideEffectFree: true
    format: json
    okExitCodes: [0]
    missingExitCodes: [1]
    loggedInField: loggedIn
    accountField: email
    verified: true
  absent: missing
`,
    'fake-claude.yaml',
  );
  return { recipes: new RecipeSet([recipe]), bin, state };
}

