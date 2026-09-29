/** Maximum members accepted by every Batch Extraction entry path. */
export const BATCH_EXTRACTION_SELECTION_LIMIT = 50

/** A Batch Extraction at or under this many members is treated as a pilot
 *  round (guided-pilot-extraction-workflow, guided-workflow-phases): it may
 *  be created against an unstabilised Schema Revision. Anything larger is a
 *  collection-scale batch and requires the revision to be stabilised first. */
export const PILOT_BATCH_SELECTION_LIMIT = 5
