import { useRef } from 'react';

/**
 * Seven-segment LCD digits (DSEG7). Unlit segments show faintly behind the value, the way a real
 * LCD does. A changed value switches on with a short dim-to-bright; the first value just appears,
 * so nothing flickers on page load.
 * Only digits, ':', '.', '-' and spaces belong here; put units and symbols in normal type next to it.
 */
export function Lcd({ value, className = '', label, still }: { value: string; className?: string; label?: string; still?: boolean }) {
  const first = useRef(value);
  const ghost = value.replace(/[0-9 -]/g, '8'); // unlit digits show their faint segments, padding included
  return (
    <span className={`lcd ${className}`} role="img" aria-label={label ?? value}>
      <span className="lcd-ghost" aria-hidden="true">
        {ghost}
      </span>
      <span className={`lcd-val ${still || first.current === value ? '' : 'changed'}`} key={value} aria-hidden="true">
        {value.replace(/ /g, '!')}
      </span>
    </span>
  );
}
