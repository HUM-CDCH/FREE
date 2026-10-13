export type SpinnerProps = {
    /** When set, renders the spinner centered above a label/hint block. */
    label?: string;
    hint?: string;
    className?: string;
};
declare function Spinner({ label, hint, className }: SpinnerProps): import("react").JSX.Element;
export default Spinner;
