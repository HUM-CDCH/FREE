class ThinkSplitter:
    """Route streamed deltas into incremental (think, output) text.

    llama.cpp-based servers stream reasoning on a separate reasoning_content
    channel with the answer in content; vLLM-style servers inline
    <think>…</think> in content. Tags can straddle chunk boundaries, so a
    trailing partial tag is withheld until the next chunk resolves it.
    """

    _START = "<think>"
    _END = "</think>"

    def __init__(self, reasoning: bool):
        # until proven otherwise, content may open with an inline think block
        self._inline_think = reasoning
        self._at_start = True
        self._buffer = ""
        self.think = ""
        self.output = ""

    def feed(self, reasoning_delta: str, content_delta: str) -> tuple[str, str]:
        think_delta, output_delta = reasoning_delta, ""
        if reasoning_delta and self._inline_think:
            # reasoning has its own channel, so content is pure output
            self._inline_think = False
            output_delta, self._buffer = self._buffer, ""
        if not self._inline_think:
            output_delta += content_delta
        elif content_delta:
            inline_think, inline_output = self._split_inline(content_delta)
            think_delta += inline_think
            output_delta += inline_output
        self.think += think_delta
        self.output += output_delta
        return think_delta, output_delta

    def close(self) -> str:
        """Flush a withheld partial tag when the stream ends mid-tag."""
        tail, self._buffer = self._buffer, ""
        self.think += tail
        return tail

    def _split_inline(self, content_delta: str) -> tuple[str, str]:
        self._buffer += content_delta
        if self._at_start:
            candidate = self._buffer.lstrip()
            if candidate.lower().startswith(self._START):
                self._buffer = candidate[len(self._START):]
                self._at_start = False
            elif self._START.startswith(candidate.lower()):
                return "", ""  # may still grow into a leading <think>; hold
            else:
                self._at_start = False

        end_idx = self._buffer.lower().find(self._END)
        if end_idx != -1:
            think, output = self._buffer[:end_idx], self._buffer[end_idx + len(self._END):]
            self._buffer = ""
            self._inline_think = False
            return think, output

        held = self._partial_end_len()
        think, self._buffer = self._buffer[: len(self._buffer) - held], self._buffer[len(self._buffer) - held:]
        return think, ""

    def _partial_end_len(self) -> int:
        for length in range(min(len(self._buffer), len(self._END) - 1), 0, -1):
            if self._buffer[-length:].lower() == self._END[:length]:
                return length
        return 0
