// The app icon (a bee on an indigo tile), inline so it stays sharp at any size. Same drawing as
// apps/desktop/assets/icon.svg, cropped to the tile; ids are per instance so several can share a page.
import { useId } from 'react';
import type { ReactNode } from 'react';

export function Logo(props: { size?: number; className?: string }): ReactNode {
  const s = props.size ?? 28;
  const id = useId().replace(/:/g, '');
  const tile = `${id}-tile`;
  const body = `${id}-body`;
  const wing = `${id}-wing`;
  const clip = `${id}-clip`;
  return (
    <svg width={s} height={s} viewBox="100 100 824 824" aria-hidden="true" className={props.className}>
      <defs>
        <linearGradient id={tile} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f46e5" />
          <stop offset="1" stopColor="#1e1b4b" />
        </linearGradient>
        <linearGradient id={body} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fde047" />
          <stop offset="1" stopColor="#f59e0b" />
        </linearGradient>
        <linearGradient id={wing} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="1" stopColor="#c7d2fe" stopOpacity="0.75" />
        </linearGradient>
        <clipPath id={clip}>
          <ellipse cx="0" cy="0" rx="150" ry="205" />
        </clipPath>
      </defs>
      <rect x="100" y="100" width="824" height="824" rx="186" fill={`url(#${tile})`} />
      <g fill="none" stroke="#a5b4fc" strokeOpacity="0.14" strokeWidth="10">
        <path d="M760 190 l70 40 v80 l-70 40 l-70 -40 v-80 z" />
        <path d="M830 310 l70 40 v80 l-70 40 l-70 -40 v-80 z" />
        <path d="M690 310 l70 40 v80 l-70 40 l-70 -40 v-80 z" />
      </g>
      <path d="M200 790 C 270 690, 330 750, 390 680" fill="none" stroke="#fde047" strokeOpacity="0.55" strokeWidth="16" strokeLinecap="round" strokeDasharray="2 38" />
      <g transform="translate(535 565) rotate(28) scale(0.8)">
        <ellipse cx="-125" cy="-150" rx="105" ry="150" transform="rotate(-28 -125 -150)" fill={`url(#${wing})`} />
        <ellipse cx="125" cy="-150" rx="105" ry="150" transform="rotate(28 125 -150)" fill={`url(#${wing})`} />
        <path d="M-26 196 L0 262 L26 196 Z" fill="#1c1917" />
        <g clipPath={`url(#${clip})`}>
          <ellipse cx="0" cy="0" rx="150" ry="205" fill={`url(#${body})`} />
          <rect x="-200" y="-40" width="400" height="58" fill="#1c1917" />
          <rect x="-200" y="70" width="400" height="58" fill="#1c1917" />
          <rect x="-200" y="175" width="400" height="60" fill="#1c1917" />
        </g>
        <circle cx="0" cy="-200" r="84" fill="#1c1917" />
        <circle cx="-34" cy="-220" r="20" fill="#ffffff" />
        <circle cx="34" cy="-220" r="20" fill="#ffffff" />
        <circle cx="-30" cy="-216" r="9" fill="#1c1917" />
        <circle cx="38" cy="-216" r="9" fill="#1c1917" />
        <path d="M-36 -285 C -60 -345, -95 -360, -120 -365" fill="none" stroke="#1c1917" strokeWidth="16" strokeLinecap="round" />
        <path d="M36 -285 C 60 -345, 95 -360, 120 -365" fill="none" stroke="#1c1917" strokeWidth="16" strokeLinecap="round" />
        <circle cx="-122" cy="-366" r="20" fill="#1c1917" />
        <circle cx="122" cy="-366" r="20" fill="#1c1917" />
      </g>
    </svg>
  );
}
