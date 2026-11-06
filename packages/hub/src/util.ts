import type { Logger } from '@bizzi/protocol';

export const nullLogger: Logger = {
  log() {},
  child() {
    return nullLogger;
  },
};
