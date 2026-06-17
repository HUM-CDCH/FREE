import unittest

from shared.temperature import ReasoningTemperature


class ReasoningTemperatureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.policy = ReasoningTemperature()

    def test_explicit_override_is_honored_regardless_of_reasoning(self) -> None:
        self.assertEqual(self.policy.resolve(0.9, reasoning=False), 0.9)
        self.assertEqual(self.policy.resolve(0.9, reasoning=True), 0.9)
        # An explicit 0.0 is a value, not "no override".
        self.assertEqual(self.policy.resolve(0.0, reasoning=True), 0.0)

    def test_default_depends_on_reasoning(self) -> None:
        self.assertEqual(self.policy.resolve(None, reasoning=False), 0.2)
        self.assertEqual(self.policy.resolve(None, reasoning=True), 0.6)


if __name__ == "__main__":
    unittest.main()
