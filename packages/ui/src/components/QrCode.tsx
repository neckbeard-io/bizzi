import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { qrMatrix, qrPath } from '../lib/qr.ts';

/** A QR code rendered client-side as one SVG path (always dark on white so every scanner reads it). */
export function QrCode(props: { value: string; size?: number; className?: string; title?: string }): ReactNode {
  const { path, n } = useMemo(() => {
    const m = qrMatrix(props.value);
    return { path: qrPath(m), n: m.length };
  }, [props.value]);
  const size = props.size ?? 192;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" className={props.className} role="img" aria-label={props.title ?? 'QR code'}>
      <rect width={n} height={n} fill="#ffffff" />
      <path d={path} fill="#111114" />
    </svg>
  );
}
