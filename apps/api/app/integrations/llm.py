"""The only module that imports LLM SDKs (ADR 0018).

Backends: fake (default, no tokens), OpenAI, Anthropic Claude and Google Gemini. The tenant's
admin picks provider and model in Settings; API keys come from the environment/vault only.
Every SDK runs with retries off: the scheduler owns retries, so a transient error is raised (the
scheduler retries it) and a permanent one (no credits, bad request, auth) becomes a handled failure.
"""

import asyncio
import json
import time
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Generic, Protocol, TypeVar

import anthropic
import openai
from google import genai
from google.genai import errors as genai_errors
from google.genai import types as genai_types
from pydantic import BaseModel, ValidationError

from app.core.settings import get_settings
from app.domain.prompting import Prompt, PromptSignal, RoleProfile
from app.schemas.llm import CardBatch, CardDraft

T = TypeVar("T", bound=BaseModel)
TIMEOUT_S = 120
_JOIN = chr(10) * 2  # between reasoning parts
MAX_OUTPUT_TOKENS = 20000  # the most a non-streaming Anthropic call may ask for


@dataclass(frozen=True)
class LLMResult:
    provider: str
    model: str
    raw: str
    batch: CardBatch | None
    input_tokens: int
    output_tokens: int
    latency_ms: int
    error: str | None = None


@dataclass(frozen=True)
class Structured(Generic[T]):  # noqa: UP046 (methods share the module TypeVar)
    """Any agent's structured answer (ADR 0022). parsed is None when the call failed."""

    provider: str
    model: str
    raw: str
    parsed: T | None
    input_tokens: int
    output_tokens: int
    latency_ms: int
    error: str | None = None
    thinking: str = ""  # the model's own reasoning text when the provider returns it
    # Included in input_tokens already. Cached reads cost a tenth of a normal input token and a
    # cache write a quarter more, so the split is what makes the real cost knowable.
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0


class LLMClient(Protocol):
    async def generate(
        self, prompt: Prompt, signals: list[PromptSignal], profile: RoleProfile
    ) -> LLMResult: ...

    async def structured(
        self,
        system: str,
        user: str,
        schema: type[T],
        fake: T | None = None,
        effort: str = "low",
        timeout_s: float | None = None,
        cache_chars: int | None = None,
    ) -> Structured[T]: ...


class _CardsFromStructured:
    """Card writing is one structured call with the CardBatch schema."""

    async def structured(
        self,
        system: str,
        user: str,
        schema: type[T],
        fake: T | None = None,
        effort: str = "low",
        timeout_s: float | None = None,
        cache_chars: int | None = None,
    ) -> Structured[T]:
        raise NotImplementedError

    async def generate(
        self, prompt: Prompt, signals: list[PromptSignal], profile: RoleProfile
    ) -> LLMResult:
        r = await self.structured(prompt.system, prompt.user, CardBatch)
        return LLMResult(
            r.provider, r.model, r.raw, r.parsed, r.input_tokens, r.output_tokens,
            r.latency_ms, r.error,
        )  # fmt: skip


def _ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


def _failed(provider: str, model: str, started: float, error: str) -> Structured[Any]:
    return Structured(provider, model, "", None, 0, 0, _ms(started), error[:1000])


class OpenAILLM(_CardsFromStructured):
    """Structured output (Responses API) parsed straight into the schema."""

    def __init__(self, api_key: str, model: str) -> None:
        self._client = openai.AsyncOpenAI(api_key=api_key, max_retries=0, timeout=TIMEOUT_S)
        self._model = model

    async def structured(
        self,
        system: str,
        user: str,
        schema: type[T],
        fake: T | None = None,
        effort: str = "low",
        timeout_s: float | None = None,
        cache_chars: int | None = None,
    ) -> Structured[T]:
        started = time.perf_counter()
        try:
            response = await self._client.responses.parse(
                model=self._model,
                instructions=system,
                input=user,
                text_format=schema,
                reasoning={"effort": effort, "summary": "auto"},  # type: ignore[arg-type]
                store=False,
                timeout=timeout_s or TIMEOUT_S,
            )
        except openai.APIStatusError as exc:
            if _openai_transient(exc):
                raise  # the scheduler retries
            return _failed("openai", self._model, started, f"{exc.status_code}: {exc.message}")
        usage = response.usage
        refusal = next(
            (
                item.refusal
                for out in response.output
                if out.type == "message"
                for item in out.content
                if item.type == "refusal"
            ),
            None,
        )
        return Structured(
            provider="openai",
            model=self._model,
            raw=response.output_text,
            parsed=None if refusal else response.output_parsed,
            input_tokens=usage.input_tokens if usage else 0,
            output_tokens=usage.output_tokens if usage else 0,
            latency_ms=_ms(started),
            error=f"refusal: {refusal}" if refusal else None,
            thinking=_JOIN.join(
                part.text
                for out in response.output
                if out.type == "reasoning"
                for part in out.summary
            ).strip(),
        )


def _openai_transient(exc: openai.APIStatusError) -> bool:
    """Rate limits and server errors pass; an exhausted quota or a 4xx does not (iteration 3)."""
    if isinstance(exc, openai.RateLimitError):
        code = (exc.body or {}).get("code") if isinstance(exc.body, dict) else None
        return code != "insufficient_quota" and "no credits" not in exc.message.lower()
    return exc.status_code >= 500 or exc.status_code == 408


# Models that accept server-side refusal fallbacks ("default" routes by refusal category).
_CLAUDE_FALLBACK_MODELS = {"claude-opus-5-5", "claude-sonnet-5-5"}


class AnthropicLLM(_CardsFromStructured):
    """Messages API structured output parsed into the schema. Thinking is adaptive; card writing
    runs at effort low, onboarding agents ask for more (ADR 0026).

    `cache_chars` marks the first characters of the user message as a stable prefix (a workspace's
    whole context in the chat): the provider keeps it for a few minutes, so the next question that
    starts with the same text pays a tenth of the price for it. The text sent is unchanged."""

    def __init__(self, api_key: str, model: str) -> None:
        self._client = anthropic.AsyncAnthropic(api_key=api_key, max_retries=0, timeout=TIMEOUT_S)
        self._model = model

    async def structured(
        self,
        system: str,
        user: str,
        schema: type[T],
        fake: T | None = None,
        effort: str = "low",
        timeout_s: float | None = None,
        cache_chars: int | None = None,
    ) -> Structured[T]:
        started = time.perf_counter()
        fallback = self._model in _CLAUDE_FALLBACK_MODELS
        try:
            response = await self._client.beta.messages.parse(
                model=self._model,
                max_tokens=MAX_OUTPUT_TOKENS,
                system=system,
                messages=[{"role": "user", "content": _cached_content(user, cache_chars)}],
                output_format=schema,
                output_config={"effort": effort},  # type: ignore[arg-type]
                thinking={"type": "adaptive", "display": "summarized"},  # the lab shows it
                timeout=timeout_s or TIMEOUT_S,
                betas=["server-side-fallback-2026-07-01"] if fallback else anthropic.omit,
                fallbacks="default" if fallback else anthropic.omit,
            )
        except anthropic.APIStatusError as exc:
            if _anthropic_transient(exc):
                raise
            return _failed("anthropic", self._model, started, f"{exc.status_code}: {exc.message}")
        except ValidationError as exc:  # cut off at max_tokens, or not the schema's shape
            return _failed(
                "anthropic", self._model, started,
                f"the answer was cut off or did not fit the schema ({exc.error_count()} problems); "
                "lower the thinking effort or shorten the input",
            )  # fmt: skip
        error = None
        if response.stop_reason == "refusal":
            category = response.stop_details.category if response.stop_details else None
            error = f"refusal: {category or 'unspecified'}"
        elif response.stop_reason == "max_tokens":
            error = "output cut off at max_tokens"
        elif response.parsed_output is None:
            error = "no structured output"
        usage = response.usage
        read = getattr(usage, "cache_read_input_tokens", 0) or 0
        wrote = getattr(usage, "cache_creation_input_tokens", 0) or 0
        return Structured(
            provider="anthropic",
            model=response.model,  # the fallback model, if one answered
            raw="".join(b.text for b in response.content if b.type == "text"),
            parsed=None if error else response.parsed_output,
            input_tokens=usage.input_tokens + read + wrote,
            output_tokens=usage.output_tokens,
            cache_read_tokens=read,
            cache_write_tokens=wrote,
            latency_ms=_ms(started),
            error=error,
            thinking=_JOIN.join(
                str(getattr(b, "thinking", "") or "")
                for b in response.content
                if b.type == "thinking"
            ).strip(),
        )


def _cached_content(user: str, cache_chars: int | None) -> Any:
    """The user message, with its stable first part marked for the provider's prompt cache. The
    text is exactly the same; only where it is cut changes. No mark when nothing follows it."""
    if not cache_chars or not 0 < cache_chars < len(user):
        return user
    return [
        {"type": "text", "text": user[:cache_chars], "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": user[cache_chars:]},
    ]


def _anthropic_transient(exc: anthropic.APIStatusError) -> bool:
    """408, 429, 5xx and 529 (overloaded) pass. A low credit balance is a 400: permanent."""
    return exc.status_code in (408, 429) or exc.status_code >= 500


class GeminiLLM(_CardsFromStructured):
    """generate_content with a JSON response schema parsed into the schema. Thinking level low."""

    def __init__(self, api_key: str, model: str) -> None:
        # No retry_options: the SDK makes a single attempt. The timeout is in milliseconds.
        self._client = genai.Client(
            api_key=api_key, http_options=genai_types.HttpOptions(timeout=TIMEOUT_S * 1000)
        )
        self._model = model

    async def structured(
        self,
        system: str,
        user: str,
        schema: type[T],
        fake: T | None = None,
        effort: str = "low",
        timeout_s: float | None = None,
        cache_chars: int | None = None,
    ) -> Structured[T]:
        started = time.perf_counter()
        config = genai_types.GenerateContentConfig(
            system_instruction=system,
            response_mime_type="application/json",
            response_schema=schema,
            max_output_tokens=MAX_OUTPUT_TOKENS,
            thinking_config=genai_types.ThinkingConfig(
                thinking_level=genai_types.ThinkingLevel.LOW
                if effort == "low"
                else genai_types.ThinkingLevel.HIGH
            ),
        )
        try:
            response = await self._client.aio.models.generate_content(
                model=self._model, contents=user, config=config
            )
        except genai_errors.APIError as exc:
            if _gemini_transient(exc):
                raise
            return _failed("gemini", self._model, started, f"{exc.code}: {exc.message}")
        usage = response.usage_metadata
        parsed = response.parsed if isinstance(response.parsed, schema) else None
        error = None
        if parsed is None:
            feedback = response.prompt_feedback
            finish = response.candidates[0].finish_reason if response.candidates else None
            reason = feedback.block_reason if feedback and feedback.block_reason else finish
            error = f"no structured output ({reason})"
        tokens_out = 0
        if usage:
            tokens_out = (usage.candidates_token_count or 0) + (usage.thoughts_token_count or 0)
        return Structured(
            provider="gemini",
            model=self._model,
            raw=response.text or "",
            parsed=parsed,
            input_tokens=(usage.prompt_token_count or 0) if usage else 0,
            output_tokens=tokens_out,
            latency_ms=_ms(started),
            error=error,
        )


def _gemini_transient(exc: genai_errors.APIError) -> bool:
    """Rate limits and 5xx pass. An exhausted plan quota ("...plan and billing") does not."""
    if exc.code == 429:
        return "billing" not in (exc.message or "").lower()
    return exc.code in (408, 500, 502, 503, 504)


class UnconfiguredLLM(_CardsFromStructured):
    """The chosen provider has no API key: fail the step once instead of three retried 503s."""

    def __init__(self, provider: str, model: str, env_var: str) -> None:
        self._provider, self._model, self._env_var = provider, model, env_var

    async def structured(
        self,
        system: str,
        user: str,
        schema: type[T],
        fake: T | None = None,
        effort: str = "low",
        timeout_s: float | None = None,
        cache_chars: int | None = None,
    ) -> Structured[T]:
        error = f"{self._env_var} is not set on the API server"
        return _failed(self._provider, self._model, time.perf_counter(), error)


_FAKE_TEXT = {
    "en": {
        "title": "{entity}: {metric} at {current} {unit} (was {baseline})",
        "what": "{metric} for {entity} is {current} {unit} in the week of {week}, "
        "against a {weeks}-week average of {baseline} {unit}.",
        "so_what": "Estimated impact: {impact} {currency} if this continues.",
        "now_what": "{decision}: act on {entity} this week.",
    },
    "fr": {
        "title": "{entity} : {metric} à {current} {unit} (contre {baseline})",
        "what": "{metric} pour {entity} : {current} {unit} la semaine du {week}, "
        "pour une moyenne de {baseline} {unit} sur {weeks} semaines.",
        "so_what": "Impact estimé : {impact} {currency} si la tendance se maintient.",
        "now_what": "{decision} : agir sur {entity} cette semaine.",
    },
}


def _fmt(value: float, language: str) -> str:
    text = f"{value:g}" if abs(value) < 1000 else f"{round(value):,}"
    return text.replace(",", " ").replace(".", ",") if language == "fr" else text


class FakeLLM:
    """Deterministic cards from the signals, using only evidence numbers. No network. Other
    agents get the `fake` answer their caller supplies (a safe, rule-based default)."""

    def __init__(self, latency_ms: int = 0) -> None:
        self._latency = latency_ms / 1000

    async def structured(
        self,
        system: str,
        user: str,
        schema: type[T],
        fake: T | None = None,
        effort: str = "low",
        timeout_s: float | None = None,
        cache_chars: int | None = None,
    ) -> Structured[T]:
        if fake is None:
            return _failed("fake", "fake-cards-v1", time.perf_counter(), "no fake answer")
        raw = fake.model_dump_json()
        tokens_in, tokens_out = len(system + user) // 4, len(raw) // 4
        return Structured("fake", "fake-cards-v1", raw, fake, tokens_in, tokens_out, 0)

    async def generate(
        self, prompt: Prompt, signals: list[PromptSignal], profile: RoleProfile
    ) -> LLMResult:
        if self._latency:
            await asyncio.sleep(self._latency)
        lang = profile.language if profile.language in _FAKE_TEXT else "en"
        text = _FAKE_TEXT[lang]
        decision = profile.decisions_owned[0] if profile.decisions_owned else "Review"
        cards = []
        for s in signals:
            e = s.evidence
            values = {
                "entity": s.entity,
                "metric": e["metric"],
                "unit": e["unit"],
                "current": _fmt(e["current_value"], lang),
                "baseline": _fmt(e["baseline_mean"], lang),
                "weeks": e["baseline_weeks"],
                "week": e["current_week"],
                "impact": _fmt(e["estimated_impact"], lang),
                "currency": e["impact_unit"],
                "decision": decision,
            }
            cards.append(
                CardDraft(
                    signal_id=s.signal_id,
                    title=text["title"].format(**values)[:80],
                    what=text["what"].format(**values),
                    so_what=text["so_what"].format(**values),
                    now_what=text["now_what"].format(**values),
                    decision_used=decision,
                    expected_impact=e["estimated_impact"],
                    impact_unit=e["impact_unit"],
                    confidence=0.6,
                    suggested_window_days=60,
                    suggested_metric_key=s.metric_key,
                )
            )
        batch = CardBatch(cards=cards)
        approx_tokens = len(prompt.system + prompt.user) // 4
        return LLMResult(
            provider="fake",
            model="fake-cards-v1",
            raw=batch.model_dump_json(),
            batch=batch,
            input_tokens=approx_tokens,
            output_tokens=len(batch.model_dump_json()) // 4,
            latency_ms=0,
        )


KEY_ENV = {"openai": "OPENAI_API_KEY", "anthropic": "ANTHROPIC_API_KEY", "gemini": "GEMINI_API_KEY"}


def api_key(provider: str) -> str | None:
    settings = get_settings()
    keys = {
        "openai": settings.openai_api_key,
        "anthropic": settings.anthropic_api_key,
        "gemini": settings.gemini_api_key,
    }
    return keys.get(provider) or None


def is_configured(provider: str) -> bool:
    return provider == "fake" or api_key(provider) is not None


@lru_cache
def get_llm(provider: str, model: str) -> LLMClient:
    """One client per (provider, model). The caller validates the choice (domain/llm.py)."""
    if provider == "fake":
        return FakeLLM(get_settings().fake_llm_latency_ms)
    key = api_key(provider)
    if key is None:
        return UnconfiguredLLM(provider, model, KEY_ENV[provider])
    if provider == "anthropic":
        return AnthropicLLM(key, model)
    if provider == "gemini":
        return GeminiLLM(key, model)
    return OpenAILLM(key, model)


def prompt_payload(prompt: Prompt) -> dict[str, Any]:
    return {"system": prompt.system, "user": prompt.user}


def parse_raw(raw: str) -> CardBatch:
    return CardBatch.model_validate(json.loads(raw))
