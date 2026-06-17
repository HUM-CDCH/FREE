from typing import Protocol


class TemperaturePolicy(Protocol):
    """Resolve the temperature for a model call from an optional override."""

    def resolve(self, override: float | None, reasoning: bool) -> float: ...


class ReasoningTemperature:
    """The model-card rule: honor an explicit override, otherwise 0.2 without
    reasoning and 0.6 with reasoning."""

    def resolve(self, override: float | None, reasoning: bool) -> float:
        if override is not None:
            return override
        return 0.6 if reasoning else 0.2
