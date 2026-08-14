const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const WINDOWS_ILLEGAL = /[<>:"/\\|?*]|\p{Cc}/gu;
const MAX_NAME_LENGTH = 255;

export type ExportFormat = "csv" | "xlsx";

/** Builds `<source-name>-extraction-result.<format>` as a Windows-safe name. */
export function createExportFilename(sourceName: string, format: ExportFormat): string {
  const leaf = sourceName.split(/[\\/]/).at(-1) ?? "";
  let name = leaf
    .replace(/\.[^.]+$/, "")
    .replace(WINDOWS_ILLEGAL, "-")
    .replace(/\s+/g, " ")
    .replace(/[ .]+$/g, "")
    .trim();

  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  if (name.length === 0) name = "result";

  const suffix = `-extraction-result.${format}`;
  return `${name.slice(0, MAX_NAME_LENGTH - suffix.length).replace(/[ .]+$/g, "")}${suffix}`;
}
