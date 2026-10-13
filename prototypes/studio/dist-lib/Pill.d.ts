import type { HTMLAttributes } from 'react';
type Tone = 'neutral' | 'accent' | 'evidence' | 'success' | 'stale' | 'danger';
export type PillProps = HTMLAttributes<HTMLSpanElement> & {
    tone?: Tone;
    /** Add a hairline border (used for the muted "summary" chips). */
    outline?: boolean;
};
declare function Pill({ tone, outline, className, ...props }: PillProps): import("react").JSX.Element;
export default Pill;
