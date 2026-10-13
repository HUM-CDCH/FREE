export type Segment<T extends string> = {
    value: T;
    label: React.ReactNode;
    /** Optional title/tooltip for the segment. */
    title?: string;
};
export type SegmentedControlProps<T extends string> = {
    options: ReadonlyArray<Segment<T>>;
    value: T;
    onChange: (value: T) => void;
    /** Accessible label for the group. */
    'aria-label'?: string;
    className?: string;
};
declare function SegmentedControl<T extends string>({ options, value, onChange, className, ...rest }: SegmentedControlProps<T>): import("react").JSX.Element;
export default SegmentedControl;
