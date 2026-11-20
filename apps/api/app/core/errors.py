"""Service-layer errors, mapped to HTTP responses in main.py."""


class NotFound(Exception):
    """Missing, or not visible to the caller (indistinguishable on purpose)."""


class Forbidden(Exception):
    """The caller can see the object but may not change it."""


class Conflict(Exception):
    """The object is not in a state that allows the change (e.g. the card is no longer open)."""


class Invalid(ValueError):
    """Input that breaks a business rule (422)."""
