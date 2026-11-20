"""structlog setup. tenant_id and run_id are bound via contextvars and appear on every line."""

import logging

import structlog

_CONTEXT_KEYS = ("tenant_id", "run_id")


def _ensure_context_keys(
    _logger: object, _method: str, event_dict: structlog.typing.EventDict
) -> structlog.typing.EventDict:
    for key in _CONTEXT_KEYS:
        event_dict.setdefault(key, None)
    return event_dict


def configure_logging(level: str = "INFO", json: bool = False) -> None:
    renderer: structlog.typing.Processor = (
        structlog.processors.JSONRenderer() if json else structlog.dev.ConsoleRenderer()
    )
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            _ensure_context_keys,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            renderer,
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.getLevelName(level.upper())),
        cache_logger_on_first_use=True,
    )


def bind_request_context(tenant_id: str | None = None, run_id: str | None = None) -> None:
    structlog.contextvars.bind_contextvars(tenant_id=tenant_id, run_id=run_id)


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)  # type: ignore[no-any-return]
