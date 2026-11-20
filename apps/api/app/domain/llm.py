"""LLM providers and models an admin can pick per tenant (ADR 0018). Pure data and validation."""

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class ModelOption:
    id: str
    label: str
    note: str


@dataclass(frozen=True)
class Provider:
    key: str
    label: str
    default_model: str
    models: tuple[ModelOption, ...]


PROVIDERS: dict[str, Provider] = {
    p.key: p
    for p in (
        Provider(
            "anthropic",
            "Anthropic Claude",
            "claude-haiku-5-5",  # chosen for card writing (docs/llm-costs.md)
            (
                ModelOption("claude-opus-5-5", "Claude Opus 5.5", "Most capable · $4 / $20 per 1M"),
                ModelOption("claude-sonnet-5-5", "Claude Sonnet 5.5", "Balanced · $2 / $10 per 1M"),
                ModelOption(
                    "claude-haiku-5-5", "Claude Haiku 5.5", "Fastest · $0.10 / $0.50 per 1M"
                ),
            ),
        ),
        Provider(
            "openai",
            "OpenAI",
            "gpt-6.1-sol",
            (ModelOption("gpt-6.1-sol", "GPT-6.1 Sol", "Reasoning model"),),
        ),
        Provider(
            "gemini",
            "Google Gemini",
            "gemini-4-argon",
            (
                ModelOption("gemini-4-argon", "Gemini 4 Argon", "Flagship reasoning"),
                ModelOption("gemini-3.8-flash", "Gemini 3.8 Flash", "Fast"),
                ModelOption("gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite", "Lowest cost"),
            ),
        ),
        Provider(
            "fake",
            "Built-in test writer",
            "fake-cards-v1",
            (ModelOption("fake-cards-v1", "Template cards", "No tokens, no network"),),
        ),
    )
}

# Any listed model, or a custom id (a newer release) that looks like a model name.
_MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$")


def validate_choice(provider: str, model: str) -> str | None:
    """Error message, or None when the choice is valid."""
    p = PROVIDERS.get(provider)
    if p is None:
        return f"unknown provider {provider!r}"
    if provider == "fake" and model != p.default_model:
        return "the test writer has a single model"
    if not _MODEL_ID.match(model):
        return f"invalid model id {model!r}"
    return None


# USD per 1M tokens (input, output) for the usage screen; docs/llm-costs.md has the measurements.
PRICES: dict[str, tuple[float, float]] = {
    "claude-opus-5-5": (4.0, 20.0),
    "claude-sonnet-5-5": (2.0, 10.0),
    "claude-haiku-5-5": (0.10, 0.50),
    "fake-cards-v1": (0.0, 0.0),
}
# Card runs measured ~80% input tokens (docs/llm-costs.md): used when only a total is known.
INPUT_SHARE = 0.8


def estimated_cost(model: str, tokens: int) -> float | None:
    price = PRICES.get(model)
    if price is None:
        return None
    blended = price[0] * INPUT_SHARE + price[1] * (1 - INPUT_SHARE)
    return round(tokens * blended / 1e6, 4)
