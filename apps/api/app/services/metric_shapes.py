"""Which standard shape each metric template reads (from catalog/metric_library).

The metrics step uses it to put a role's relevant measures first: a buyer's list starts with the
measures on purchase orders, not on wholesale accounts. Read once; the catalog does not change
while the API runs.
"""

from functools import lru_cache
from pathlib import Path

import yaml

from app.core.settings import get_settings


@lru_cache(maxsize=1)
def template_shapes() -> dict[str, str]:
    root = Path(get_settings().catalog_dir) / "metric_library"
    found: dict[str, str] = {}
    for f in sorted(root.glob("*.yaml")):
        doc = yaml.safe_load(f.read_text(encoding="utf-8"))
        for m in doc.get("metrics", []):
            if m.get("template"):
                found.setdefault(str(m["template"]), str(doc["archetype"]))
    return found
