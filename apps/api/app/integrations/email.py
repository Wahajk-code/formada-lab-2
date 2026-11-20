"""Transactional email over SMTP (WF4 digest). Locally SMTP_HOST points at Mailpit, whose inbox is
at http://localhost:8025. With no SMTP_HOST the message is logged and not sent."""

import asyncio
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage

from app.core.logging import get_logger
from app.core.settings import get_settings

log = get_logger(__name__)


@dataclass(frozen=True)
class Mail:
    to: str
    subject: str
    text: str
    html: str


def _send(mail: Mail) -> None:
    s = get_settings()
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = s.mail_from, mail.to, mail.subject
    msg.set_content(mail.text)
    msg.add_alternative(mail.html, subtype="html")
    with smtplib.SMTP(s.smtp_host or "", s.smtp_port, timeout=20) as smtp:
        smtp.send_message(msg)


async def send(mail: Mail) -> bool:
    if not get_settings().smtp_host:
        log.info("email.not_configured", to=mail.to, subject=mail.subject)
        return False
    await asyncio.to_thread(_send, mail)
    return True
