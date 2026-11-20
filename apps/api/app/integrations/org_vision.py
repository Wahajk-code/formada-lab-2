"""Reading a photo of a hand-drawn org chart (ADR 0027).

Only a mock for now: it ignores the image and returns a sample chart, so the builder flow can be
tried end to end. The real reader will go through integrations/llm.py (an image to a model) and
needs the client's consent to send names; nothing in the image leaves us today.
"""

import asyncio
from typing import Protocol

Box = tuple[str, str, str]  # (title, name, department)
Chart = tuple[dict[str, Box], list[tuple[str, str]]]  # boxes by id, (parent, child) lines


class OrgVision(Protocol):
    async def read(self, image: bytes, media_type: str) -> Chart: ...


class MockOrgVision:
    async def read(self, image: bytes, media_type: str) -> Chart:
        del image, media_type
        await asyncio.sleep(1.5)
        boxes = {
            "a": ("CEO", "", ""),
            "b": ("VP Operations", "", "Operations"),
            "c": ("Planner", "", "Operations"),
            "d": ("DC Manager", "", "Operations"),
            "e": ("Stores Manager", "", "Retail"),
            "f": ("Finance", "", "Finance"),
        }
        return boxes, [("a", "b"), ("b", "c"), ("b", "d"), ("b", "e"), ("a", "f")]


def get_org_vision() -> OrgVision:
    return MockOrgVision()
