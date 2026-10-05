import type { EvidenceLink } from '../shared/groundedExtraction'

/** Who linked a supported value to its evidence: the verifier, or a rule (code's lexical match, a recipe's key or
 *  structure). */
export type LinkOrigin = 'verifier' | 'rule'

/** A link is the verifier's when a unified Catalog's verification accepted it, or when it carries no rule at all (an
 *  Article model link); `lexical`/`citation_lexical` links and recipe `key`/`structure` links are rule-made. */
export function linkOrigin(link: Pick<EvidenceLink, 'linkedBy' | 'grounding'>): LinkOrigin {
  if (link.grounding) return link.grounding.linkedBy === 'verification' ? 'verifier' : 'rule'
  return link.linkedBy === undefined ? 'verifier' : 'rule'
}
