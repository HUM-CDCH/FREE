/**
 * Developer UI flag: controls display of developer/debug tooling like the
 * raw Evidence tab in RightRail.
 *
 * Hidden by default; set VITE_SHOW_DEVELOPER_UI=true to restore them.
 */
export function isDeveloperUiEnabled(): boolean {
  return import.meta.env.VITE_SHOW_DEVELOPER_UI === 'true'
}
