/** A chat bubble: the researcher's on the right in the accent, the reply on the left on the surface. */
export const chatMessageClass = (role: 'user' | 'assistant') =>
  role === 'user'
    ? 'self-end max-w-[88%] rounded-[11px_11px_3px_11px] bg-accent px-3 py-1.5 text-secondary leading-relaxed text-white'
    : 'self-start max-w-[92%] rounded-[11px_11px_11px_3px] border border-line bg-surface px-3 py-1.5 text-secondary leading-relaxed text-ink'
