import { Ink } from './Ink';
import type { IconName } from '../domain/spot';
import { FOOD_ICONS, UI_ICONS } from './icons';

export type UiIconName = keyof typeof UI_ICONS | 'dice';

interface IconProps {
  name: UiIconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
}

export function Icon({ name, size = 20, strokeWidth = 2.2, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {name === 'dice' ? (
        <>
          <path d="M7.5 4h9A3.5 3.5 0 0 1 20 7.5v9a3.5 3.5 0 0 1-3.5 3.5h-9A3.5 3.5 0 0 1 4 16.5v-9A3.5 3.5 0 0 1 7.5 4z" />
          <path
            d="M9 9h.01 M15 9h.01 M12 12h.01 M9 15h.01 M15 15h.01"
            strokeWidth={strokeWidth * 1.45}
          />
        </>
      ) : (
        <path d={UI_ICONS[name]} />
      )}
    </svg>
  );
}

const TINTS = ['var(--tint-yellow)', 'var(--tint-pink)', 'var(--tint-sand)'] as const;
const TILTS = ['-3deg', '2deg', '-1.5deg', '3deg', '-2deg'] as const;

/** The little tilted tile with the food doodle. Tint + tilt vary by position. */
export function FoodTile({
  icon,
  index,
  size = 54,
}: {
  icon: IconName;
  index: number;
  size?: number;
}) {
  const tint = TINTS[index % TINTS.length] ?? TINTS[0];
  const tilt = TILTS[index % TILTS.length] ?? TILTS[0];
  return (
    <span
      className="sk flat"
      aria-hidden="true"
      style={{
        '--fill': tint,
        '--bw': '2px',
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: 'var(--r-tile)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transform: `rotate(${tilt})`,
      }}
    >
      <Ink />
      <svg
        width={Math.round(size * 0.6)}
        height={Math.round(size * 0.6)}
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--ink)"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={FOOD_ICONS[icon]} />
      </svg>
    </span>
  );
}
