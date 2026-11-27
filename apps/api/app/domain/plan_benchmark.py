"""Benchmarks for the Org web and Metrics steps: obvious things the AI chose, checked by code.

Same idea as the Discovery and Mapping benchmarks. For the org web: one root and it is the CEO,
every reporting line leads to a real role, a role's type belongs to its department's playbook, and
data that Mapping can read has a role to read it. For the metrics plan: every measure uses a real
template, goes to a role that exists, reads a data shape that can be built, belongs to that role's
area, every role gets at least one, and no alert level is absurd (an alert on supplier lead time at
275 days is a data problem, not a threshold).

Pure; no AI, no warehouse. Probes have the same shape as the other benchmarks'.
"""

from typing import Any

from app.domain.discovery_benchmark import _probe, grade

# Which playbook reads which data (as on the Org page: "which roles will have data").
CORE = {
    "purchasing": ["purchase_order_line"],
    "sales": ["sales_line"],
    "inventory": ["inventory_snapshot"],
}
CORE_FOR_ROLE = {"account_manager": ["wholesale_order_line"], "sales_ops": ["sales_line"]}
# The area a data shape belongs to, and who may be given its measures.
SHAPE_PLAYBOOK = {
    "purchase_order": "purchasing",
    "purchase_order_line": "purchasing",
    "sales_line": "sales",
    "wholesale_order_line": "sales",
    "inventory_position": "inventory",
    "inventory_snapshot": "inventory",
}
# A level beyond these is not a real alert level for that unit.
IMPLAUSIBLE = {"days": 180.0, "percentage points": 100.0, "%": 100.0}

ORG_CRITICAL = {"tree_valid", "archetype_real"}
METRICS_CRITICAL = {"templates_exist", "roles_exist", "shape_runs", "thresholds"}


def _playbooks(catalog: list[dict[str, Any]]) -> dict[str, str]:
    return {str(a["key"]): str(a.get("playbook", "")) for a in catalog}


def _unmappable(mapping: dict[str, Any] | None) -> set[str]:
    return {
        str(a["archetype"])
        for a in (mapping or {}).get("archetypes", [])
        if a.get("status") == "unmappable"
    }


def _core(archetype: str, playbook: str) -> list[str]:
    if playbook == "executive":
        return sorted({s for v in CORE.values() for s in v})
    return CORE_FOR_ROLE.get(archetype) or CORE.get(playbook, [])


# ---- the org web -------------------------------------------------------------------------------


def run_org(
    out: dict[str, Any], catalog: list[dict[str, Any]] | None, mapping: dict[str, Any] | None
) -> dict[str, Any] | None:
    roles = out.get("roles") or []
    if not roles:
        return None
    play = _playbooks(catalog or [])
    refs = [str(r["ref"]) for r in roles]
    by_ref = {str(r["ref"]): r for r in roles}
    probes: list[dict[str, str]] = []

    roots = [r for r in roles if not r.get("parent_ref")]
    ok = len(roots) == 1 and roots[0].get("archetype") == "ceo"
    probes.append(
        _probe(
            "one_root",
            "Shape",
            "One root, and it is the CEO",
            "one role at the top, the CEO",
            f"{len(roots)} at the top"
            + (": " + ", ".join(str(r["title"]) for r in roots[:3]) if not ok else ""),
            "pass" if ok else "fail",
        )
    )

    problems: list[str] = []
    if len(set(refs)) != len(refs):
        problems.append("two roles share a reference")
    for r in roles:
        if r.get("parent_ref") and r["parent_ref"] not in by_ref:
            problems.append(f"{r['title']} reports to a role that does not exist")
        seen, cur = set(), r
        while cur and cur.get("parent_ref") and cur["ref"] not in seen:
            seen.add(cur["ref"])
            cur = by_ref.get(cur["parent_ref"])
        if cur and cur.get("parent_ref") and cur["ref"] in seen:
            problems.append(f"{r['title']} is in a reporting loop")
    probes.append(
        _probe(
            "tree_valid",
            "Shape",
            "Every reporting line leads to the CEO",
            "a tree, no loops, no missing bosses",
            "a clean tree" if not problems else "; ".join(sorted(set(problems))[:3]),
            "pass" if not problems else "fail",
        )
    )

    if play:
        unknown = [str(r["title"]) for r in roles if r.get("archetype") not in play]
        probes.append(
            _probe(
                "archetype_real",
                "Roles",
                "Every role has a real role type",
                "a type from the catalog",
                "all real" if not unknown else "not in the catalog: " + ", ".join(unknown[:3]),
                "pass" if not unknown else "fail",
            )
        )

    depts = {str(d["name"]): d for d in out.get("departments", [])}
    bad: list[str] = []
    for r in roles:
        if r.get("department") and r["department"] not in depts:
            bad.append(f"{r['title']} is in a department that is not declared")
    for d in depts.values():
        head = by_ref.get(str(d.get("head_ref")))
        if head is None:
            bad.append(f"{d['name']} has no head")
        elif head.get("department") != d["name"]:
            bad.append(f"the head of {d['name']} is in another department")
    probes.append(
        _probe(
            "departments",
            "Roles",
            "Departments are consistent",
            "each department has a head who belongs to it",
            "consistent" if not bad else "; ".join(bad[:3]),
            "pass" if not bad else "fail",
        )
    )

    if play:
        off = []
        for r in roles:
            dept = depts.get(str(r.get("department")))
            mine = play.get(str(r.get("archetype")), "")
            if dept and mine and mine != "executive" and dept.get("playbook") != mine:
                off.append(f"{r['title']} is a {mine} role in a {dept.get('playbook')} department")
        probes.append(
            _probe(
                "playbook_fit",
                "Roles",
                "Roles sit in the department of their type",
                "a role's type matches its department",
                "all fit" if not off else "; ".join(off[:3]),
                "pass" if not off else "fail",
            )
        )

    if mapping and play:
        dead = _unmappable(mapping)
        for playbook, shapes in CORE.items():
            if any(s in dead for s in shapes):
                continue
            staffed = any(play.get(str(r.get("archetype"))) == playbook for r in roles)
            probes.append(
                _probe(
                    f"data_staffed:{playbook}",
                    "Data",
                    f"{playbook.capitalize()} data has a role to read it",
                    "a role of that type when the data can be read",
                    "yes" if staffed else "no role of that type",
                    "pass" if staffed else "fail",
                )
            )
        stuck = [
            str(r["title"])
            for r in roles
            if (core := _core(str(r.get("archetype")), play.get(str(r.get("archetype")), "")))
            and all(s in dead for s in core)
        ]
        probes.append(
            _probe(
                "no_dead_role",
                "Data",
                "No role that can never get cards",
                "every role has data it can read",
                "none"
                if not stuck
                else "waiting on data that cannot be built: " + ", ".join(stuck[:3]),
                "pass" if not stuck else "fail",
            )
        )
    return grade(probes, ORG_CRITICAL)


# ---- the metrics plan --------------------------------------------------------------------------


def _threshold_problems(m: dict[str, Any]) -> list[str]:
    found = []
    limit = IMPLAUSIBLE.get(str(m.get("unit", "")).lower())
    for a in m.get("attach", []):
        who = f"{m.get('name', m.get('key'))} for {a.get('role_ref')}"
        value = a.get("threshold_value")
        if value is not None and limit is not None and float(value) > limit:
            found.append(f"{who}: alert level {value:g} {m.get('unit')} is not believable")
        w = a.get("weight")
        if w is not None and not 0.1 <= float(w) <= 3:
            found.append(f"{who}: weight {w} is outside 0.1 to 3")
        t = a.get("threshold") or {}
        if t.get("kind") == "percentile" and not 50 <= float(t.get("value", 0)) <= 99:
            found.append(f"{who}: percentile {t.get('value')} is outside 50 to 99")
    if float(m.get("unit_value", 0) or 0) < 0:
        found.append(f"{m.get('name', m.get('key'))}: negative money value")
    return found


def run_metrics(
    out: dict[str, Any],
    roles_seen: list[dict[str, Any]] | None,
    known_templates: set[str] | None,
    shapes: dict[str, str] | None,
    mapping: dict[str, Any] | None,
    catalog: list[dict[str, Any]] | None,
) -> dict[str, Any] | None:
    """roles_seen are the roles the metrics step was shown (with the references measures attach
    to); known_templates is every template the catalog and the metric library hold, including the
    workspace's own, so a measure added later from the library is not called invented."""
    metrics = out.get("metrics") or []
    if not metrics:
        return None
    play = _playbooks(catalog or [])
    roles = {str(r["ref"]): r for r in roles_seen or []}
    dead = _unmappable(mapping)
    probes: list[dict[str, str]] = []

    if known_templates:
        missing = [str(m["template"]) for m in metrics if m["template"] not in known_templates]
        probes.append(
            _probe(
                "templates_exist",
                "Plan",
                "Every measure uses a real template",
                "a template of the catalog",
                "all real" if not missing else "not in the catalog: " + ", ".join(missing[:3]),
                "pass" if not missing else "fail",
            )
        )
    if shapes and mapping:
        stuck = [str(m["name"]) for m in metrics if shapes.get(str(m["template"])) in dead]
        probes.append(
            _probe(
                "shape_runs",
                "Plan",
                "Every measure reads data that can be built",
                "no measure on a shape that cannot be mapped",
                "all can run" if not stuck else "cannot run: " + ", ".join(stuck[:3]),
                "pass" if not stuck else "fail",
            )
        )

    if roles:
        gone = sorted(
            {
                str(a["role_ref"])
                for m in metrics
                for a in m.get("attach", [])
                if a["role_ref"] not in roles
            }
        )
        probes.append(
            _probe(
                "roles_exist",
                "Plan",
                "Every measure goes to a role that exists",
                "the roles the plan was given",
                "all real" if not gone else "no such role: " + ", ".join(gone[:3]),
                "pass" if not gone else "fail",
            )
        )
        attached = {str(a["role_ref"]) for m in metrics for a in m.get("attach", [])}
        unmeasured = [str(r["title"]) for ref, r in roles.items() if ref not in attached]
        probes.append(
            _probe(
                "every_role_measured",
                "Plan",
                "Every role has at least one measure",
                "each role has something to be alerted on",
                "all have" if not unmeasured else "none for: " + ", ".join(unmeasured[:3]),
                "pass" if not unmeasured else "fail",
            )
        )
        if shapes and play:
            odd = []
            for m in metrics:
                area = SHAPE_PLAYBOOK.get(shapes.get(str(m["template"]), ""), "")
                for a in m.get("attach", []):
                    r = roles.get(str(a["role_ref"]))
                    mine = play.get(str(r.get("archetype")), "") if r else ""
                    if r and area and mine and mine not in ("executive", area):
                        odd.append(f"{m['name']} ({area}) for {r['title']} ({mine})")
            probes.append(
                _probe(
                    "area_fit",
                    "Plan",
                    "Measures belong to the role's area",
                    "a buyer gets purchasing measures, not sales",
                    "all fit" if not odd else "; ".join(odd[:3]),
                    "pass" if not odd else "fail",
                )
            )

    orphans = [str(m["name"]) for m in metrics if not m.get("attach")]
    keys = [str(m["key"]) for m in metrics]
    dup = sorted({k for k in keys if keys.count(k) > 1})
    probes.append(
        _probe(
            "no_orphans",
            "Plan",
            "Every measure is attached once",
            "each measure goes to a role, no repeats",
            "clean"
            if not (orphans or dup)
            else "; ".join(
                [
                    *(f"{n} goes to nobody" for n in orphans[:2]),
                    *(f"{k} is listed twice" for k in dup[:2]),
                ]
            ),
            "pass" if not (orphans or dup) else "fail",
        )
    )
    wrong = [p for m in metrics for p in _threshold_problems(m)]
    probes.append(
        _probe(
            "thresholds",
            "Numbers",
            "Alert levels and weights are believable",
            "no alert level beyond what the unit allows",
            "all believable" if not wrong else "; ".join(wrong[:3]),
            "pass" if not wrong else "fail",
        )
    )
    return grade(probes, METRICS_CRITICAL)
