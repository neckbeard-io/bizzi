// Cobalt2 by Wes Bos (wesbos/cobalt2-vscode), MIT; copyright notice in NOTICE. Colours from the VS Code
// theme (theming.md §4), not the base24 port; the other tokens derive from these (resolve.ts). Dark
// only: light mode falls back to it.
import type { Theme } from '../types.ts';

const ansi = ['#000000', '#ff628c', '#3ad900', '#ffc600', '#0088ff', '#fb94ff', '#80fcff', '#ffffff', '#0050A4', '#ff628c', '#3ad900', '#ffc600', '#0088ff', '#fb94ff', '#80fcff', '#ffffff'] as const;

export const cobalt2: Theme = {
  id: 'cobalt2',
  name: 'Cobalt2',
  author: 'Wes Bos',
  license: 'MIT',
  description: 'Deep blue with the signature yellow.',
  variants: {
    dark: {
      colors: {
        background: '#193549', // editor.background
        foreground: '#ffffff', // editor.foreground
        card: '#122738', // activityBar.background
        primary: '#ffc600', // editorCursor.foreground
        primaryForeground: '#193549',
        border: '#0d3a58', // focusBorder
        ring: '#0088ff', // button.background
        sidebar: '#15232d', // sideBar.background
      },
      terminal: { background: '#122738', foreground: '#ffffff', cursor: '#ffc600', selection: '#0050A4', ansi },
    },
  },
};
