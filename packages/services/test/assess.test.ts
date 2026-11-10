// InstallAssessor.decorate: the recipe's supported-version verdict vs one the adapter reports itself.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parsePlatform } from '@bizzi/provision';
import { InstallAssessor } from '../src/index.ts';

const assessor = new InstallAssessor({ platform: parsePlatform('darwin-arm64'), env: { PATH: '/nowhere' }, home: '/nowhere' });

describe('InstallAssessor.decorate', () => {
  it('judges an old version against the recipe', () => {
    const out = assessor.decorate({ agent: 'claude', installed: true, auth: 'ok', path: '/nowhere/claude', version: '1.0.0' });
    assert.equal(out.support, 'unsupported');
    assert.ok(out.supportReason);
  });

  it("keeps the adapter's own verdict and drops the recipe's upgrade remedy (bizzi serve --fake)", () => {
    const fake = { agent: 'claude', installed: true, auth: 'ok', path: '/fake/bin', version: '0.0.0-fake' } as const;
    assert.equal(assessor.decorate(fake).support, 'unsupported', 'the recipe alone refuses the fake version');
    const out = assessor.decorate({ ...fake, support: 'ok' });
    assert.equal(out.support, 'ok');
    assert.equal(out.supportReason, undefined);
    assert.ok(!(out.remedies ?? []).some((r) => r.kind === 'upgrade'));
  });
});
