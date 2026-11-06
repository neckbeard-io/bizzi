// Keeps the status bar / navigation bar icons readable when the UI switches theme.
// The UI sets <html data-theme="dark|light"> (packages/ui/public/theme-init.js and its settings).

/** Capacitor SystemBarsStyle values: 'DARK' = light icons for a dark background, and vice versa. */
export type BarStyle = 'DARK' | 'LIGHT' | 'DEFAULT';

export function barStyleForTheme(theme: string | null | undefined): BarStyle {
  if (theme === 'dark') return 'DARK';
  if (theme === 'light') return 'LIGHT';
  return 'DEFAULT';
}

/**
 * Apply the bar style now and whenever `data-theme` changes on the root element.
 * Returns a function that stops watching.
 */
export function watchTheme(root: HTMLElement, apply: (style: BarStyle) => void): () => void {
  let last: BarStyle | null = null;
  const sync = (): void => {
    const style = barStyleForTheme(root.dataset['theme']);
    if (style === last) return;
    last = style;
    apply(style);
  };
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
