"""WF4 weekly digest: each person gets their new cards and value captured (spec: workflows).

"Their" cards follow card ownership: the roles they hold as owner, plus vacant roles routing to
them. Value captured covers the initiatives they own. People with nothing new get no email.
"""

import uuid
from datetime import UTC, datetime, timedelta
from html import escape
from typing import Any

from sqlalchemy import select

from app.core.db import tenant_tx
from app.core.logging import get_logger
from app.core.settings import get_settings
from app.domain import org as org_rules
from app.integrations import email
from app.models import (
    AuditLog,
    Initiative,
    InsightCard,
    Outcome,
    Person,
    RoleAssignment,
    Tenant,
)
from app.repositories import org as org_repo

log = get_logger(__name__)

TEXT = {
    "en": {
        "subject": "Formada: {n} new card{s} this week",
        "subject_none": "Formada: your week",
        "hello": "Hello {name},",
        "new": "New cards for your roles:",
        "value": "Value captured on your initiatives (change vs baseline, not causation): {v}",
        "open": "Open Formada: {url}",
    },
    "fr": {
        "subject": "Formada : {n} nouvelle{s} carte{s} cette semaine",
        "subject_none": "Formada : votre semaine",
        "hello": "Bonjour {name},",
        "new": "Nouvelles cartes pour vos rôles :",
        "value": "Valeur captée sur vos initiatives (écart vs la base, pas une causalité) : {v}",
        "open": "Ouvrir Formada : {url}",
    },
}


def _money(value: float, currency: str, locale: str) -> str:
    text = f"{value:,.0f}"
    return f"{text.replace(',', ' ')} $" if locale == "fr" else f"${text} {currency}"


def render(
    name: str, locale: str, cards: list[InsightCard], value: float, currency: str, url: str
) -> email.Mail | None:
    if not cards and not value:
        return None
    t = TEXT.get(locale, TEXT["en"])
    plural = "s" if len(cards) > 1 else ""
    subject = t["subject"].format(n=len(cards), s=plural) if cards else t["subject_none"]
    lines = [t["hello"].format(name=name), ""]
    html = [f"<p>{escape(t['hello'].format(name=name))}</p>"]
    if cards:
        lines.append(t["new"])
        html.append(f"<p><strong>{escape(t['new'])}</strong></p><ol>")
        for c in cards:
            impact = _money(float(c.expected_impact), currency, locale)
            lines.append(f"  - {c.title} ({impact})")
            link = f"{url}/cards?role={c.role_node_id}&card={c.id}"
            html.append(
                f'<li><a href="{escape(link)}">{escape(c.title)}</a> · {escape(impact)}</li>'
            )
        html.append("</ol>")
    if value:
        v = t["value"].format(v=_money(value, currency, locale))
        lines += ["", v]
        html.append(f"<p>{escape(v)}</p>")
    lines += ["", t["open"].format(url=url)]
    html.append(f'<p><a href="{escape(url)}">{escape(t["open"].format(url=url))}</a></p>')
    return email.Mail(to="", subject=subject, text="\n".join(lines), html="".join(html))


async def send(tenant_id: uuid.UUID, slot: datetime) -> dict[str, Any]:
    async with tenant_tx("service", tenant_id) as s:
        tenant = await s.get(Tenant, tenant_id)
        assert tenant is not None
        rules = await org_repo.rules(s)
        nodes = await org_repo.nodes(s)
        since = datetime.now(UTC) - timedelta(days=rules.digest_lookback_days)
        people = (await s.scalars(select(Person).order_by(Person.name))).all()
        assignments = (
            await s.execute(
                select(RoleAssignment.person_id, RoleAssignment.role_node_id).where(
                    RoleAssignment.permission == "owner", RoleAssignment.grant_effect == "allow"
                )
            )
        ).all()
        new_cards = (
            await s.scalars(
                select(InsightCard)
                .where(InsightCard.status == "open", InsightCard.created_at >= since)
                .order_by(InsightCard.expected_impact.desc())
            )
        ).all()
        values = (
            await s.execute(
                select(Initiative.owner_person_id, Outcome.value_captured)
                .join(Initiative, Initiative.id == Outcome.initiative_id)
                .where(Outcome.created_at >= since)
            )
        ).all()

    url = get_settings().app_base_url
    sent = skipped = 0
    for p in people:
        owned: set[uuid.UUID] = set()
        for person_id, role_id in assignments:
            if person_id == p.id:
                owned |= org_rules.owned_nodes(nodes, role_id)
        cards = [c for c in new_cards if c.role_node_id in owned][: rules.max_open_cards_per_role]
        value = sum(float(v) for owner, v in values if owner == p.id)
        mail = render(p.name, p.locale, cards, value, tenant.currency, url)
        if mail is None:
            skipped += 1
            continue
        if await email.send(email.Mail(p.email, mail.subject, mail.text, mail.html)):
            sent += 1
    async with tenant_tx("service", tenant_id) as s:
        s.add(
            AuditLog(
                tenant_id=tenant_id,
                actor="scheduler",
                action="digest.sent",
                object_type="tenant",
                object_id=str(tenant_id),
                detail={"slot": slot.isoformat(), "sent": sent, "skipped": skipped},
            )
        )
    log.info("digest.sent", sent=sent, skipped=skipped)
    return {"status": "ok", "sent": sent, "skipped": skipped}
