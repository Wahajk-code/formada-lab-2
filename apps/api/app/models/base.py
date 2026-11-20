import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, MetaData, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, declared_attr, mapped_column

NAMING = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING)


class UUIDPk:
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )


class Timestamped:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class TenantScoped:
    """Every tenant table carries tenant_id; the migration adds the RLS tenant policy for each."""

    @declared_attr
    def tenant_id(cls) -> Mapped[uuid.UUID]:
        return mapped_column(
            UUID(as_uuid=True),
            ForeignKey("tenant.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        )


def one_of(column: str, values: tuple[str, ...], name: str | None = None) -> CheckConstraint:
    allowed = ", ".join(f"'{v}'" for v in values)
    return CheckConstraint(f"{column} IN ({allowed})", name=name or column)
