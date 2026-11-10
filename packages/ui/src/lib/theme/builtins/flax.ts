// Five-tone palettes from flax (neckbeard-io/flax, the bizzi author's own music player; theming.md §4).
// Only the ones Chorus doesn't already ship by name: Nord, Catppuccin and Gruvbox use the
// hand-authored Terax/Chorus sets, whose accents agree with flax's tones. flax's Dracula replaces the
// base16 Dracula because it also has a light variant.
import { fiveToneTheme } from '../fiveTone.ts';
import type { Theme } from '../types.ts';

const tones = (background: string, foreground: string, primary: string, secondary: string, tertiary: string) => ({ background, foreground, primary, secondary, tertiary });

export const evergreen: Theme = fiveToneTheme(
  { id: 'evergreen', name: 'Evergreen', author: 'flax', description: 'Forest greens with a gold tertiary.' },
  { light: tones('#F2F7F2', '#1B2A20', '#2E7D4F', '#4F7A5B', '#8A6D1F'), dark: tones('#151D18', '#DDE8DF', '#6FCF97', '#A3D9A5', '#E3C27A') },
);

export const dracula: Theme = fiveToneTheme(
  { id: 'dracula', name: 'Dracula', author: 'flax; palette: Dracula by Zeno Rocha', license: 'palette MIT', description: 'Dracula, with a light variant.' },
  { light: tones('#FFFBEB', '#1F1F1F', '#644AC9', '#A3144D', '#036A96'), dark: tones('#282A36', '#F8F8F2', '#BD93F9', '#FF79C6', '#8BE9FD') },
);

export const synthwave: Theme = fiveToneTheme(
  { id: 'synthwave', name: 'Synthwave', author: 'flax', description: 'Neon magenta and cyan.' },
  { light: tones('#FDF4FF', '#2A1036', '#C2187A', '#00838F', '#8A6A00'), dark: tones('#1A1029', '#F2E9FF', '#FF3EA5', '#2DE2E6', '#FFD319') },
);

/** flax's tones for the palettes Chorus also ships, kept to check the accents agree (tests). */
export const FLAX_OVERLAP = {
  nord: { light: tones('#ECEFF4', '#2E3440', '#4C6F9A', '#5E81AC', '#8F6A89'), dark: tones('#2E3440', '#ECEFF4', '#88C0D0', '#81A1C1', '#B48EAD') },
  catppuccin: { light: tones('#EFF1F5', '#4C4F69', '#8839EF', '#EA76CB', '#7287FD'), dark: tones('#1E1E2E', '#CDD6F4', '#CBA6F7', '#F5C2E7', '#B4BEFE') },
  gruvbox: { light: tones('#FBF1C7', '#3C3836', '#AF3A03', '#B57614', '#427B58'), dark: tones('#282828', '#EBDBB2', '#FE8019', '#FABD2F', '#8EC07C') },
} as const;
