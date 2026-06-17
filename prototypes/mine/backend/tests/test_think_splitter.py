import unittest

from shared.think_splitter import ThinkSplitter


class ThinkSplitterBufferedTests(unittest.TestCase):
    """The splitter must separate reasoning from answer over a single buffered
    feed, not only across a per-delta streaming loop."""

    def test_inline_think_block_split_in_one_feed(self) -> None:
        splitter = ThinkSplitter(reasoning=True)
        think, output = splitter.feed("", "<think>weighing options</think>the answer")
        splitter.close()
        self.assertEqual(think, "weighing options")
        self.assertEqual(output, "the answer")
        self.assertEqual(splitter.think, "weighing options")
        self.assertEqual(splitter.output, "the answer")

    def test_separate_reasoning_channel_in_one_feed(self) -> None:
        splitter = ThinkSplitter(reasoning=True)
        think, output = splitter.feed("the reasoning", "the answer")
        splitter.close()
        self.assertEqual(splitter.think, "the reasoning")
        self.assertEqual(splitter.output, "the answer")

    def test_reasoning_off_passes_content_through_as_output(self) -> None:
        splitter = ThinkSplitter(reasoning=False)
        splitter.feed("", "plain content")
        splitter.close()
        self.assertEqual(splitter.think, "")
        self.assertEqual(splitter.output, "plain content")


if __name__ == "__main__":
    unittest.main()
