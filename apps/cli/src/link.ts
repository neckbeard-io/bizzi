// Hub link for `bizzi serve`: load (or, with BIZZI_PAIR_CODE, create) the hub credential and keep the node
// linked to the hub. Runs in the background; the local server works regardless of the link.

import { BizziError, type Logger } from '@bizzi/protocol';
import type { BizziNode } from '@bizzi/core';
import { connectToHub, hubNodeUrl, loadCredential, type HubCredential, type HubLink } from '@bizzi/hub';
import { pairNode } from './pair.ts';

export interface HubLinkConfig {
  dataDir: string;
  /** --connect / $BIZZI_HUB_URL. When unset, the saved credential's URL is used (if any). */
  url?: string;
  /** $BIZZI_PAIR_CODE: pair on first start when there is no credential yet. */
  pairCode?: string;
  logger: Logger;
}

export interface HubLinkHandle {
  readonly link: HubLink | undefined;
  close(): Promise<void>;
}

/** Returns undefined when no hub is configured (no URL and no saved credential). */
export function startHubLink(node: BizziNode, cfg: HubLinkConfig): HubLinkHandle | undefined {
  const log = cfg.logger.child({ component: 'hub-link' });
  let cred: HubCredential | undefined;
  try {
    cred = loadCredential(cfg.dataDir);
  } catch (err) {
    log.log('error', 'cannot read the hub credential; not connecting', { err: (err as Error).message });
    return undefined;
  }
  if (!cred && !cfg.url) return undefined;
  if (!cred && !cfg.pairCode) {
    log.log('warn', 'not paired with a hub; run "bizzi pair <hub-url> <code>" or set BIZZI_PAIR_CODE', { hub: cfg.url });
    return undefined;
  }
  if (cred && cred.machineId && cred.machineId !== node.machine.id) {
    log.log('error', 'hub credential belongs to a different machine; re-pair with "bizzi pair --force"', {
      credentialMachineId: cred.machineId,
      machineId: node.machine.id,
    });
    return undefined;
  }

  let closed = false;
  let link: HubLink | undefined;
  let wake: (() => void) | undefined;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });

  const run = (async () => {
    let attempt = 0;
    while (!cred && !closed) {
      try {
        const res = await pairNode({
          dataDir: cfg.dataDir,
          hubUrl: cfg.url!,
          code: cfg.pairCode!,
          name: node.machine.name,
          machineId: node.machine.id,
        });
        cred = res.credential;
        log.log('info', 'paired with hub', { deviceId: cred.deviceId, file: res.file });
      } catch (err) {
        if (err instanceof BizziError && err.code !== 'machine_offline' && err.code !== 'internal') {
          log.log('error', 'auto-pairing failed; check BIZZI_PAIR_CODE (codes are single use and expire)', { err: err.message });
          return;
        }
        attempt++;
        log.log('info', 'hub not reachable for pairing yet; retrying', { err: (err as Error).message, attempt });
        await sleep(Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)) * (0.5 + Math.random() / 2));
      }
    }
    if (closed || !cred) return;
    const url = cfg.url ? hubNodeUrl(cfg.url) : cred.hubUrl;
    link = connectToHub(node, { url, credentials: cred, logger: cfg.logger });
  })();

  return {
    get link() {
      return link;
    },
    async close() {
      closed = true;
      wake?.();
      await run;
      await link?.close();
    },
  };
}
