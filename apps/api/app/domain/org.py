"""Org web rules on plain objects: vacant routing and roll-up selection (ADR 0005, 0007)."""

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True)
class Node:
    id: uuid.UUID
    parent_id: uuid.UUID | None
    vacant: bool


@dataclass(frozen=True)
class CardRef:
    id: uuid.UUID
    role_node_id: uuid.UUID
    expected_impact: Decimal


def nearest_filled_ancestor(nodes: dict[uuid.UUID, Node], node_id: uuid.UUID) -> uuid.UUID | None:
    """The node that owns a node's cards: itself if filled, else the first filled ancestor."""
    current: uuid.UUID | None = node_id
    while current is not None:
        node = nodes[current]
        if not node.vacant:
            return node.id
        current = node.parent_id
    return None


def owned_nodes(nodes: dict[uuid.UUID, Node], role_id: uuid.UUID) -> set[uuid.UUID]:
    """role_id plus every vacant node whose cards route to it."""
    return {n for n in nodes if nearest_filled_ancestor(nodes, n) == role_id}


def descendants(nodes: dict[uuid.UUID, Node], role_id: uuid.UUID) -> set[uuid.UUID]:
    children: dict[uuid.UUID, list[uuid.UUID]] = {}
    for node in nodes.values():
        if node.parent_id is not None:
            children.setdefault(node.parent_id, []).append(node.id)
    found: set[uuid.UUID] = set()
    stack = list(children.get(role_id, []))
    while stack:
        n = stack.pop()
        found.add(n)
        stack.extend(children.get(n, []))
    return found


def rollup(
    nodes: dict[uuid.UUID, Node],
    role_id: uuid.UUID,
    open_cards: Iterable[CardRef],
    top_n: int,
) -> list[CardRef]:
    """Top open cards owned by descendants (not routed to role_id itself), by expected impact."""
    below = descendants(nodes, role_id) - owned_nodes(nodes, role_id)
    candidates: Sequence[CardRef] = [c for c in open_cards if c.role_node_id in below]
    return sorted(candidates, key=lambda c: c.expected_impact, reverse=True)[:top_n]


def card_owner(nodes: dict[uuid.UUID, Node], card_role_id: uuid.UUID) -> uuid.UUID | None:
    """The role that may act on a card: its own node, or for a vacant node the nearest filled
    ancestor its cards route to (ADR 0005)."""
    return nearest_filled_ancestor(nodes, card_role_id)


def can_act(
    nodes: dict[uuid.UUID, Node], card_role_id: uuid.UUID, owner_role_ids: set[uuid.UUID]
) -> bool:
    """Only a person holding the owning role with owner permission can action or flag a card."""
    owner = card_owner(nodes, card_role_id)
    return owner is not None and owner in owner_role_ids
