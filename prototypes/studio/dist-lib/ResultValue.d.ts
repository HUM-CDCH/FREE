export type ResultPath = string[];
export type OnResultChange = (path: ResultPath, value: string) => void;
export type ResultValueProps = {
    name: string;
    value: unknown;
    path?: ResultPath;
    onChange?: OnResultChange;
    depth?: number;
    defaultExpanded?: boolean;
    /** When provided, clicking an ObjectSection/ArraySection header navigates to
     *  that node instead of toggling expand/collapse. The callback receives the
     *  node's full path so ResultsTab can update navPath. */
    onNavigateTo?: (path: string[]) => void;
    /** When true, long primitive values are shown in full without a More button. */
    expandText?: boolean;
    /** Exact canonical Evidence link for a scalar result path, when grounded. */
    getEvidenceAnchorId?: (path: ResultPath) => string | undefined;
    onSelectEvidence?: (anchorId: string) => void;
};
declare function ResultValue({ name, value, path, onChange, depth, defaultExpanded, onNavigateTo, expandText, getEvidenceAnchorId, onSelectEvidence }: ResultValueProps): import("react").JSX.Element;
export default ResultValue;
