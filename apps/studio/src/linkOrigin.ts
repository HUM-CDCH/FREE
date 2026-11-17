import type { EvidenceLink } from 'extraction/durable-types'

/** Who linked a supported value to its evidence: the verifier, or code's lexical rule. */
export type LinkOrigin = 'verifier' | 'rule'

/** A link is the verifier's when a unified Catalog's verification accepted it, or when it carries no rule at all (an
 *  Article model link); `lexical` links are rule-made. */
export function linkOrigin(link: Pick<EvidenceLink, 'linkedBy' | 'grounding'>): LinkOrigin {
  if (link.grounding) return link.grounding.linkedBy === 'verification' ? 'verifier' : 'rule'
  return link.linkedBy === undefined ? 'verifier' : 'rule'
}
