// Pure HTML rewrite used by the stage step: load native-bridge.js before anything else in <head>.

export const BRIDGE_FILE = 'native-bridge.js';

const MARKER = 'data-bizzi-native-bridge';

/**
 * Insert `<script src="./native-bridge.js" data-bizzi-native-bridge></script>` as the first script
 * in the document: before the first <script> tag if there is one (the UI's theme-init.js and module
 * bundle), else right before </head>. A classic, non-deferred script, so `window.bizziNative` is
 * defined before any UI code runs. Idempotent. Throws if the HTML has neither a <script> nor </head>.
 */
export function injectBridgeScript(html: string, src: string = `./${BRIDGE_FILE}`): string {
  if (html.includes(MARKER)) return html;
  const tag = `<script src="${escapeAttr(src)}" ${MARKER}></script>`;

  const firstScript = html.search(/<script\b/i);
  if (firstScript >= 0) {
    const indent = leadingIndent(html, firstScript);
    return `${html.slice(0, firstScript)}${tag}\n${indent}${html.slice(firstScript)}`;
  }
  const headEnd = html.search(/<\/head\s*>/i);
  if (headEnd >= 0) {
    const indent = leadingIndent(html, headEnd);
    return `${html.slice(0, headEnd)}  ${tag}\n${indent}${html.slice(headEnd)}`;
  }
  throw new Error('injectBridgeScript: index.html has no <script> tag and no </head>');
}

function leadingIndent(html: string, index: number): string {
  const lineStart = html.lastIndexOf('\n', index - 1) + 1;
  const prefix = html.slice(lineStart, index);
  return /^[ \t]*$/.test(prefix) ? prefix : '';
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
