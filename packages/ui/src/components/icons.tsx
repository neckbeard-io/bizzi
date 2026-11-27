import type { ReactNode, SVGProps } from 'react';

// Small stroke icons (24×24, currentColor), hand-drawn to avoid an icon dependency.
const PATHS = {
  machine: 'M4 5h16v10H4zM8 19h8M12 15v4',
  home: 'M4 11l8-7 8 7M6 9.5V20h4v-6h4v6h4V9.5',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  chat: 'M4 5h16v11H9l-5 4z',
  inbox: 'M4 13l2-8h12l2 8v6H4zM4 13h5l1 2h4l1-2h5',
  terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5',
  plus: 'M12 5v14M5 12h14',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  back: 'M15 6l-6 6 6 6',
  check: 'M5 12l5 5 9-10',
  x: 'M6 6l12 12M18 6L6 18',
  stop: 'M7 7h10v10H7z',
  send: 'M5 12l14-7-5 14-2-6z',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
  sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  git: 'M6 3v12M18 9a3 3 0 1 0 0-.01M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9c0 6-12 3-12 9',
  plan: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  tool: 'M14 6a4 4 0 0 0-5 5L4 16l4 4 5-5a4 4 0 0 0 5-5l-3 3-3-1-1-3z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  question: 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.5',
  alert: 'M12 4l9 16H3zM12 10v4M12 17v.5',
  brain: 'M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 0V4zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 0',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 12l2-1-1-3-2 .2-1.2-1.2L17 5l-3-1-1 2h-2L10 4 7 5l.2 2L6 8.2 4 8l-1 3 2 1v0l-2 1 1 3 2-.2L7.2 17 7 19l3 1 1-2h2l1 2 3-1-.2-2 1.2-1.2 2 .2 1-3z',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
  tag: 'M4 4h7l9 9-7 7-9-9zM8 8.5v.01',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  key: 'M14 10a4 4 0 1 0-1.2 2.8L20 20M17 17l2-2M15.5 15.5l1.5-1.5',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  upload: 'M12 20V9M7 14l5-5 5 5M5 4h14',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z',
  scan: 'M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M4 12h16',
  phone: 'M8 3h8v18H8zM11 18h2',
  fork: 'M7 4v6a4 4 0 0 0 4 4h2a4 4 0 0 0 4-4V4M12 14v6M7 4a1 1 0 1 0 0 .01M17 4a1 1 0 1 0 0 .01',
  book: 'M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2zM4 20a2 2 0 0 0 2 1h13v-3',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z',
  wifiOff: 'M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5-2.7M14 10.3A10 10 0 0 1 19 13M2 9.5a15 15 0 0 1 4.3-2.8M12 20h.01',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
  branch: 'M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  gauge: 'M4 16a8 8 0 1 1 16 0M12 16l4-5M8 20h8',
  tree: 'M5 4h5v4H5zM14 10h5v4h-5zM14 17h5v4h-5zM7.5 8v11h6.5M7.5 12h6.5',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9.5v.01',
  more: 'M4 12a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M10.5 12a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M17 12a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon(props: { name: IconName; size?: number; className?: string } & Omit<SVGProps<SVGSVGElement>, 'name'>): ReactNode {
  const { name, size = 16, className, ...rest } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
