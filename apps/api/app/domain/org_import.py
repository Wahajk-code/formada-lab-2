"""The client's org draft (ADR 0027): node checks, file parsers and starting templates.

Pure: every parser takes bytes and returns draft nodes. A node is
{id, title, parent_id, name, email, department, vacant}. Parsers are best effort; the client
fixes what they got wrong in the builder before submitting.

Supported: CSV and Excel (our template, or any sheet with a title and a reports-to column),
Visio .vsdx (shapes joined by connectors, or org chart shape data), PowerPoint .pptx (SmartArt
org charts, or shapes joined by connectors), and a Microsoft 365 directory listing.
"""

import csv
import io
import re
import zipfile
from dataclasses import dataclass
from typing import Any
from xml.etree import ElementTree as ET

MAX_NODES = 300
MAX_UPLOAD_BYTES = 5 * 1024 * 1024
TITLE_MAX = 120
ID = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,40}$")
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
ROLE_WORDS = re.compile(
    r"\b(ceo|cfo|coo|cto|cio|cmo|vp|svp|evp|president|director|manager|head|lead|chief|planner|"
    r"buyer|analyst|officer|coordinator|supervisor|specialist|associate|owner|founder|"
    r"directeur|directrice|gestionnaire|responsable|chef|acheteur|acheteuse|planificateur)\b",
    re.IGNORECASE,
)
FILE_KINDS = ("csv", "xlsx", "vsdx", "pptx")
IMAGE_KINDS = ("png", "jpg", "jpeg", "webp", "heic")


class ImportError_(ValueError):
    """The file could not be read as an org chart; the message is shown to the client."""


# ---------------------------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------------------------


def node(
    id_: str,
    title: str,
    parent_id: str | None = None,
    name: str = "",
    email: str = "",
    department: str = "",
    vacant: bool = False,
) -> dict[str, Any]:
    return {
        "id": id_,
        "title": title.strip()[:TITLE_MAX],
        "parent_id": parent_id,
        "name": name.strip()[:200],
        "email": email.strip().lower()[:320],
        "department": department.strip()[:120],
        "vacant": vacant or not name.strip(),
    }


def clean(raw: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Normalises nodes saved from the builder. Raises ValueError on a broken structure (the
    builder never sends one); leaves content problems to `check` so drafts can be incomplete."""
    if len(raw) > MAX_NODES:
        raise ValueError(f"at most {MAX_NODES} roles")
    out = []
    for r in raw:
        nid = str(r.get("id") or "")
        if not ID.match(nid):
            raise ValueError(f"bad node id {nid!r}")
        parent = r.get("parent_id") or None
        out.append(
            node(
                nid,
                str(r.get("title") or ""),
                str(parent) if parent else None,
                str(r.get("name") or ""),
                str(r.get("email") or ""),
                str(r.get("department") or ""),
                bool(r.get("vacant")),
            )
        )
    ids = [n["id"] for n in out]
    if len(set(ids)) != len(ids):
        raise ValueError("node ids must be unique")
    known = set(ids)
    for n in out:
        if n["parent_id"] and n["parent_id"] not in known:
            n["parent_id"] = None  # a deleted parent: the node becomes a loose root
    if _has_cycle(out):
        raise ValueError("reporting lines go round in a circle")
    return ordered(out)


def _has_cycle(nodes: list[dict[str, Any]]) -> bool:
    parent = {n["id"]: n["parent_id"] for n in nodes}
    for start in parent:
        seen, cur = set(), start
        while cur:
            if cur in seen:
                return True
            seen.add(cur)
            cur = parent.get(cur)
    return False


def ordered(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Parents before children (breadth first from the roots), keeping sibling order."""
    kids: dict[str | None, list[dict[str, Any]]] = {}
    for n in nodes:
        kids.setdefault(n["parent_id"], []).append(n)
    out: list[dict[str, Any]] = []
    queue = list(kids.get(None, []))
    while queue:
        n = queue.pop(0)
        out.append(n)
        queue.extend(kids.get(n["id"], []))
    return out


@dataclass
class DraftReport:
    errors: list[str]
    warnings: list[str]

    @property
    def ok(self) -> bool:
        return not self.errors

    def as_dict(self) -> dict[str, Any]:
        return {"ok": self.ok, "errors": self.errors, "warnings": self.warnings}


def check(nodes: list[dict[str, Any]]) -> DraftReport:
    """What must be true before the client can submit the draft for review."""
    errors: list[str] = []
    warnings: list[str] = []
    if not nodes:
        return DraftReport(["add at least one role"], [])
    roots = [n for n in nodes if not n["parent_id"]]
    if len(roots) != 1:
        errors.append(f"one top role is needed (usually the CEO), found {len(roots)}")
    for n in nodes:
        if not n["title"]:
            errors.append("every role needs a title")
            break
    for n in nodes:
        if n["email"] and not EMAIL.match(n["email"]):
            errors.append(f"{n['title'] or 'a role'}: the email is not valid")
    emails = [n["email"] for n in nodes if n["email"]]
    if len(set(emails)) != len(emails):
        errors.append("the same email is on two roles")
    vacant = sum(1 for n in nodes if n["vacant"])
    if vacant and vacant == len(nodes):
        warnings.append("no one is named yet; roles can stay vacant")
    return DraftReport(errors, warnings)


def for_agent(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """What the org designer sees: titles, departments and reporting lines. Never names or
    emails (ADR 0027)."""
    return [
        {
            "ref": n["id"],
            "title": n["title"],
            "parent_ref": n["parent_id"] or "",
            "department": n["department"],
        }
        for n in nodes
    ]


def align_to_draft(
    out: dict[str, Any], nodes: list[dict[str, Any]]
) -> tuple[dict[str, Any], list[str]]:
    """Makes the designer's answer follow the client's draft: refs must be draft ids, titles are
    the client's, and each kept role reports to its nearest kept ancestor in the draft. Returns
    the corrected answer and warnings (roles left out, refs invented)."""
    by_id = {n["id"]: n for n in nodes}
    warnings: list[str] = []
    roles = []
    for r in out.get("roles", []):
        if r["ref"] not in by_id:
            warnings.append(f"{r['ref']}: not in the client's draft, dropped")
            continue
        roles.append(dict(r))
    kept = {r["ref"] for r in roles}
    for r in roles:
        n = by_id[r["ref"]]
        r["title"] = n["title"]
        parent = n["parent_id"]
        while parent and parent not in kept:
            parent = by_id[parent]["parent_id"] if parent in by_id else None
        r["parent_ref"] = parent or ""
    order = {n["id"]: i for i, n in enumerate(nodes)}
    roles.sort(key=lambda r: order[r["ref"]])
    for n in nodes:
        if n["id"] not in kept:
            warnings.append(f"{n['title']}: left out of the org web (no data for this role yet)")
    departments = [d for d in out.get("departments", []) if d["head_ref"] in kept]
    names = {d["name"] for d in departments}
    for r in roles:
        if r.get("department") and r["department"] not in names:
            r["department"] = ""
    return {**out, "roles": roles, "departments": departments}, warnings


def people(nodes: list[dict[str, Any]], applied_roles: dict[str, str]) -> list[dict[str, Any]]:
    """People named in the draft, with the role node they hold, for invites at go-live."""
    return [
        {
            "name": n["name"],
            "email": n["email"],
            "role_node_id": applied_roles[n["id"]],
            "title": n["title"],
        }
        for n in nodes
        if n["email"] and not n["vacant"] and n["id"] in applied_roles
    ]


# ---------------------------------------------------------------------------------------------
# Labels and tables
# ---------------------------------------------------------------------------------------------


def split_label(lines: list[str]) -> tuple[str, str]:
    """(title, name) from the text of a chart box. One line is a title; with two or more, the
    line that reads like a job title is the title and the first other line is the name."""
    lines = [ln.strip() for ln in lines if ln.strip()]
    if not lines:
        return "", ""
    if len(lines) == 1:
        return lines[0], ""
    titled = [ln for ln in lines if ROLE_WORDS.search(ln)]
    title = titled[0] if titled else lines[1]
    name = next((ln for ln in lines if ln != title), "")
    return title, name


HEADERS = {
    "id": ("id", "ref", "code", "identifiant"),
    "title": ("role title", "title", "role", "job title", "position", "poste", "titre"),
    "reports_to": ("reports to (id)", "reports to", "manager", "parent", "supervisor", "relève de"),
    "name": ("person name", "name", "person", "employee", "nom", "full name"),
    "email": ("email", "e-mail", "mail", "courriel"),
    "department": ("department", "dept", "team", "service", "département"),
}


def from_rows(rows: list[list[str]]) -> list[dict[str, Any]]:
    """Nodes from a table with a header row. Reports-to may name an id, a person or a title."""
    rows = [r for r in rows if any(c.strip() for c in r)]
    if len(rows) < 2:
        raise ImportError_("the sheet needs a header row and at least one role")
    header = [h.strip().lower() for h in rows[0]]
    col: dict[str, int] = {}
    for key, names in HEADERS.items():
        for i, h in enumerate(header):
            if h in names and key not in col and i not in col.values():
                col[key] = i
    if "title" not in col:
        raise ImportError_("no role title column (expected a header like 'Role title')")

    def cell(r: list[str], key: str) -> str:
        i = col.get(key)
        return r[i].strip() if i is not None and i < len(r) else ""

    body = rows[1 : MAX_NODES + 1]
    nodes = []
    for i, r in enumerate(body, start=1):
        raw_id = cell(r, "id")
        nid = f"n{i}"
        nodes.append(
            (
                raw_id,
                node(nid, cell(r, "title"), None, cell(r, "name"), cell(r, "email"),
                     cell(r, "department")),
                cell(r, "reports_to"),
            )
        )  # fmt: skip
    lookup: dict[str, str] = {}  # reports-to may be an id, a person or a title; ids win
    for raw_id, n, _ in nodes:
        if raw_id:
            lookup.setdefault(raw_id.lower(), n["id"])
    for _, n, _ in nodes:
        if n["name"]:
            lookup.setdefault(n["name"].lower(), n["id"])
    for _, n, _ in nodes:
        lookup.setdefault(n["title"].lower(), n["id"])
    out = []
    for _, n, parent in nodes:
        pid = lookup.get(parent.lower()) if parent else None
        n["parent_id"] = pid if pid != n["id"] else None
        out.append(n)
    out = [n for n in out if n["title"]]
    if _has_cycle(out):
        raise ImportError_("reporting lines in the sheet go round in a circle")
    return ordered(out)


def parse_csv(data: bytes) -> list[dict[str, Any]]:
    text = data.decode("utf-8-sig", errors="replace")
    dialect = csv.Sniffer().sniff(text[:2048], delimiters=",;\t") if text.strip() else csv.excel
    return from_rows([list(r) for r in csv.reader(io.StringIO(text), dialect)])


def _zip(data: bytes) -> zipfile.ZipFile:
    try:
        return zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise ImportError_("the file is not a valid Office document") from e


def _xml(z: zipfile.ZipFile, name: str) -> ET.Element:
    return ET.fromstring(z.read(name))


X = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def parse_xlsx(data: bytes) -> list[dict[str, Any]]:
    z = _zip(data)
    names = z.namelist()
    sheets = sorted(n for n in names if re.match(r"xl/worksheets/sheet\d+\.xml$", n))
    if not sheets:
        raise ImportError_("no worksheet in the Excel file")
    shared: list[str] = []
    if "xl/sharedStrings.xml" in names:
        for si in _xml(z, "xl/sharedStrings.xml").iter(f"{X}si"):
            shared.append("".join(t.text or "" for t in si.iter(f"{X}t")))
    rows: list[list[str]] = []
    for row in _xml(z, sheets[0]).iter(f"{X}row"):
        cells: dict[int, str] = {}
        for c in row.iter(f"{X}c"):
            ref = c.get("r", "")
            letters = re.match(r"[A-Z]+", ref)
            idx = _col_index(letters.group(0)) if letters else len(cells)
            kind, v = c.get("t"), c.find(f"{X}v")
            if kind == "s" and v is not None and v.text:
                cells[idx] = shared[int(v.text)]
            elif kind == "inlineStr":
                cells[idx] = "".join(t.text or "" for t in c.iter(f"{X}t"))
            elif v is not None and v.text:
                cells[idx] = v.text
        if cells:
            rows.append([cells.get(i, "") for i in range(max(cells) + 1)])
    return from_rows(rows)


def _col_index(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def template_rows(locale: str = "en") -> list[list[str]]:
    head = (
        ["ID", "Role title", "Reports to (ID)", "Person name", "Email", "Department"]
        if locale != "fr"
        else ["ID", "Titre", "Relève de", "Nom", "Courriel", "Département"]
    )
    sample = [
        ["1", "Chief Executive Officer", "", "", "", ""],
        ["2", "VP Operations", "1", "", "", "Operations"],
        ["3", "Inventory Planner", "2", "", "", "Operations"],
        ["4", "Distribution Centre Manager", "2", "", "", "Operations"],
    ]
    return [head, *sample]


def build_xlsx(rows: list[list[str]]) -> bytes:
    """A one-sheet Excel workbook with inline strings (no styles), for the download template."""

    def esc(v: str) -> str:
        return v.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    def col(i: int) -> str:
        s = ""
        i += 1
        while i:
            i, r = divmod(i - 1, 26)
            s = chr(65 + r) + s
        return s

    sheet_rows = "".join(
        f'<row r="{r + 1}">'
        + "".join(
            f'<c r="{col(c)}{r + 1}" t="inlineStr"><is><t>{esc(v)}</t></is></c>'
            for c, v in enumerate(row)
        )
        + "</row>"
        for r, row in enumerate(rows)
    )
    ns = "http://schemas.openxmlformats.org"
    ct = "application/vnd.openxmlformats-"
    sml = f"{ct}officedocument.spreadsheetml"
    rel = f"{ns}/officeDocument/2006/relationships"
    head = '<?xml version="1.0" encoding="UTF-8"?>'
    rels = f'{head}<Relationships xmlns="{ns}/package/2006/relationships">'
    parts = {
        "[Content_Types].xml": (
            f'{head}<Types xmlns="{ns}/package/2006/content-types">'
            f'<Default Extension="rels" ContentType="{ct}package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            f'<Override PartName="/xl/workbook.xml" ContentType="{sml}.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" '
            f'ContentType="{sml}.worksheet+xml"/>'
            "</Types>"
        ),
        "_rels/.rels": (
            f'{rels}<Relationship Id="rId1" Type="{rel}/officeDocument" '
            'Target="xl/workbook.xml"/></Relationships>'
        ),
        "xl/workbook.xml": (
            f'{head}<workbook xmlns="{ns}/spreadsheetml/2006/main" xmlns:r="{rel}"><sheets>'
            '<sheet name="Org chart" sheetId="1" r:id="rId1"/></sheets></workbook>'
        ),
        "xl/_rels/workbook.xml.rels": (
            f'{rels}<Relationship Id="rId1" Type="{rel}/worksheet" '
            'Target="worksheets/sheet1.xml"/></Relationships>'
        ),
        "xl/worksheets/sheet1.xml": (
            f'{head}<worksheet xmlns="{ns}/spreadsheetml/2006/main">'
            f"<sheetData>{sheet_rows}</sheetData></worksheet>"
        ),
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, body in parts.items():
            z.writestr(name, body)
    return buf.getvalue()


# ---------------------------------------------------------------------------------------------
# Diagrams: boxes and lines
# ---------------------------------------------------------------------------------------------


Label = tuple[str, str, str]  # (title, name, department)


def from_graph(boxes: dict[str, Label], edges: list[tuple[str, str]]) -> list[dict[str, Any]]:
    """Nodes from labelled boxes and (parent, child) lines between them."""
    ids = {b: f"n{i}" for i, b in enumerate(boxes, start=1)}
    parent: dict[str, str] = {}
    for p, c in edges:
        if p in ids and c in ids and p != c and c not in parent:
            parent[c] = p
    nodes = [
        node(ids[b], title, ids.get(parent.get(b, "")), name, department=dept)
        for b, (title, name, dept) in list(boxes.items())[:MAX_NODES]
        if title
    ]
    known = {n["id"] for n in nodes}
    for n in nodes:
        if n["parent_id"] not in known:
            n["parent_id"] = None
    if _has_cycle(nodes):
        for n in nodes:  # keep the boxes; the client draws the lines again
            n["parent_id"] = None
    if not nodes:
        raise ImportError_("no labelled boxes found in the chart")
    return ordered(nodes)


def _label(lines: list[str], department: str = "") -> Label:
    title, name = split_label(lines)
    return title, name, department


V = "{http://schemas.microsoft.com/office/visio/2012/main}"


def parse_vsdx(data: bytes) -> list[dict[str, Any]]:
    z = _zip(data)
    pages = sorted(n for n in z.namelist() if re.match(r"visio/pages/page\d+\.xml$", n))
    if not pages:
        raise ImportError_("no page in the Visio file")
    root = _xml(z, pages[0])
    connectors: dict[str, dict[str, str]] = {}
    for c in root.iter(f"{V}Connect"):
        cell = c.get("FromCell", "")
        end = "begin" if cell.startswith("Begin") else "end" if cell.startswith("End") else ""
        if end:
            connectors.setdefault(c.get("FromSheet", ""), {})[end] = c.get("ToSheet", "")
    boxes: dict[str, Label] = {}
    for shape in root.iter(f"{V}Shape"):
        sid = shape.get("ID", "")
        if sid in connectors:
            continue
        props = _shape_data(shape)
        if props.get("title"):  # org chart shapes carry Name / Title as shape data
            boxes[sid] = (props["title"], props.get("name", ""), props.get("department", ""))
            continue
        text = shape.find(f"{V}Text")
        lines = "".join(text.itertext()).splitlines() if text is not None else []
        if any(ln.strip() for ln in lines):
            boxes[sid] = _label(lines)
    edges = [(c["begin"], c["end"]) for c in connectors.values() if "begin" in c and "end" in c]
    return from_graph(boxes, edges)


def _shape_data(shape: ET.Element) -> dict[str, str]:
    out: dict[str, str] = {}
    for section in shape.findall(f"{V}Section"):
        if section.get("N") != "Property":
            continue
        for row in section.iter(f"{V}Row"):
            for cell in row.iter(f"{V}Cell"):
                if cell.get("N") == "Value" and cell.get("V"):
                    out[row.get("N", "").lower()] = cell.get("V", "")
    return out


P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
DGM = "{http://schemas.openxmlformats.org/drawingml/2006/diagram}"


def parse_pptx(data: bytes) -> list[dict[str, Any]]:
    z = _zip(data)
    names = z.namelist()
    diagrams = sorted(n for n in names if re.match(r"ppt/diagrams/data\d+\.xml$", n))
    if diagrams:
        return _smartart(_xml(z, diagrams[0]))
    slides = sorted(
        (n for n in names if re.match(r"ppt/slides/slide\d+\.xml$", n)),
        key=lambda n: int(re.findall(r"\d+", n)[-1]),
    )
    for slide in slides:
        try:
            return _slide_shapes(_xml(z, slide))
        except ImportError_:
            continue
    raise ImportError_("no org chart found in the slides (SmartArt or boxes joined by lines)")


def _smartart(root: ET.Element) -> list[dict[str, Any]]:
    boxes: dict[str, Label] = {}
    for pt in root.iter(f"{DGM}pt"):
        if pt.get("type", "node") != "node":
            continue
        paras = ["".join(t.text or "" for t in p.iter(f"{A}t")) for p in pt.iter(f"{A}p")]
        if any(x.strip() for x in paras):
            boxes[pt.get("modelId", "")] = _label(paras)
    edges = []
    for cxn in root.iter(f"{DGM}cxn"):
        if cxn.get("type", "parOf") == "parOf":
            edges.append((cxn.get("srcId", ""), cxn.get("destId", "")))
    return from_graph(boxes, edges)


def _slide_shapes(root: ET.Element) -> list[dict[str, Any]]:
    boxes: dict[str, Label] = {}
    top: dict[str, int] = {}
    for sp in root.iter(f"{P}sp"):
        pr = sp.find(f"{P}nvSpPr/{P}cNvPr")
        if pr is None:
            continue
        paras = ["".join(t.text or "" for t in p.iter(f"{A}t")) for p in sp.iter(f"{A}p")]
        if any(x.strip() for x in paras):
            sid = pr.get("id", "")
            boxes[sid] = _label(paras)
            off = sp.find(f".//{A}off")
            top[sid] = int(off.get("y", "0")) if off is not None else 0
    edges = []
    for cx in root.iter(f"{P}cxnSp"):
        st, en = cx.find(f".//{A}stCxn"), cx.find(f".//{A}endCxn")
        if st is None or en is None:
            continue
        a, b = st.get("id", ""), en.get("id", "")
        # A line has no direction in a drawing; the box higher on the slide is the manager.
        edges.append((a, b) if top.get(a, 0) <= top.get(b, 0) else (b, a))
    if not edges:
        raise ImportError_("no connected boxes on this slide")
    return from_graph(boxes, edges)


def parse_file(kind: str, data: bytes) -> list[dict[str, Any]]:
    if len(data) > MAX_UPLOAD_BYTES:
        raise ImportError_("the file is larger than 5 MB")
    try:
        if kind == "csv":
            return parse_csv(data)
        if kind == "xlsx":
            return parse_xlsx(data)
        if kind == "vsdx":
            return parse_vsdx(data)
        if kind == "pptx":
            return parse_pptx(data)
    except (ET.ParseError, KeyError, csv.Error, UnicodeDecodeError) as e:
        raise ImportError_("the file could not be read as an org chart") from e
    raise ImportError_(f"unsupported file type .{kind}")


# ---------------------------------------------------------------------------------------------
# Microsoft 365 directory and templates
# ---------------------------------------------------------------------------------------------


def from_directory(users: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Nodes from directory users {id, name, email, title, department, manager_id}. Accounts
    with neither a job title nor a manager (rooms, service accounts) are skipped."""
    people = [u for u in users if u.get("title") or u.get("manager_id")][:MAX_NODES]
    ids = {u["id"]: f"n{i}" for i, u in enumerate(people, start=1)}
    nodes = [
        node(ids[u["id"]], u.get("title") or "Role", ids.get(u.get("manager_id") or ""),
             u.get("name") or "", u.get("email") or "", u.get("department") or "")
        for u in people
    ]  # fmt: skip
    if _has_cycle(nodes):
        raise ImportError_("the directory's manager links go round in a circle")
    if not nodes:
        raise ImportError_("the directory has no people with a job title or a manager")
    return ordered(nodes)


def _tree(spec: list[tuple[str, str | None, str, str]], locale: str) -> list[dict[str, Any]]:
    out = []
    for nid, parent, en, fr in spec:
        out.append(node(nid, fr if locale == "fr" else en, parent))
    return out


TEMPLATES: dict[str, dict[str, Any]] = {
    "lean": {
        "name": {"en": "Lean leadership", "fr": "Direction allégée"},
        "about": {
            "en": "A leadership role with direct owners for operations and sales.",
            "fr": "Un rôle de direction avec des responsables des opérations et des ventes.",
        },
        "spec": [
            ("n1", None, "Chief Executive Officer", "Président-directeur général"),
            ("n2", "n1", "Head of Operations", "Responsable des opérations"),
            ("n3", "n1", "Head of Sales", "Responsable des ventes"),
        ],
    },
    "distribution": {
        "name": {"en": "Distribution business", "fr": "Entreprise de distribution"},
        "about": {
            "en": "Purchasing, Sales and Finance with specialist roles below each lead.",
            "fr": "Achats, ventes et finances, avec des rôles spécialisés sous chaque responsable.",
        },
        "spec": [
            ("n1", None, "Chief Executive Officer", "Président-directeur général"),
            ("n2", "n1", "VP Purchasing", "VP Achats"),
            ("n3", "n1", "VP Sales", "VP Ventes"),
            ("n4", "n1", "VP Finance", "VP Finances"),
            ("n5", "n2", "Buyer", "Acheteur"),
            ("n6", "n2", "Inventory Planner", "Planificateur des stocks"),
            ("n7", "n3", "Key Account Manager", "Gestionnaire de comptes clés"),
            ("n8", "n4", "Accounts Payable Lead", "Responsable des comptes fournisseurs"),
        ],
    },
    "multi": {
        "name": {"en": "Multi-department company", "fr": "Entreprise multi-départements"},
        "about": {
            "en": "A broader company structure to explore with search and branch focus.",
            "fr": "Une structure plus large à explorer avec la recherche et le focus par branche.",
        },
        "spec": [
            ("n1", None, "Chief Executive Officer", "Président-directeur général"),
            ("n2", "n1", "VP Purchasing", "VP Achats"),
            ("n3", "n1", "VP Sales", "VP Ventes"),
            ("n4", "n1", "VP Finance", "VP Finances"),
            ("n5", "n1", "VP Operations", "VP Opérations"),
            ("n6", "n1", "VP Marketing", "VP Marketing"),
            ("n7", "n1", "VP People", "VP Personnel"),
            ("n8", "n2", "Buyer", "Acheteur"),
            ("n9", "n2", "Inventory Planner", "Planificateur des stocks"),
            ("n10", "n2", "Supplier Manager", "Gestionnaire des fournisseurs"),
            ("n11", "n3", "Key Account Manager", "Gestionnaire de comptes clés"),
            ("n12", "n3", "Sales Operations Analyst", "Analyste des opérations de vente"),
            ("n13", "n3", "Inside Sales Lead", "Responsable des ventes internes"),
            ("n14", "n4", "Controller", "Contrôleur"),
            ("n15", "n4", "Financial Planning Analyst", "Analyste en planification financière"),
            ("n16", "n4", "Accounts Payable Lead", "Responsable des comptes fournisseurs"),
            ("n17", "n5", "Warehouse Manager", "Directeur d'entrepôt"),
            ("n18", "n5", "Logistics Coordinator", "Coordonnateur de la logistique"),
            ("n19", "n5", "Store Operations Manager", "Directeur des opérations magasins"),
            ("n20", "n6", "Brand Manager", "Gestionnaire de marque"),
            ("n21", "n6", "Digital Marketing Lead", "Responsable du marketing numérique"),
            ("n22", "n7", "Recruiter", "Recruteur"),
            ("n23", "n7", "HR Business Partner", "Partenaire d'affaires RH"),
        ],
    },
}


def template(key: str, locale: str) -> list[dict[str, Any]]:
    if key not in TEMPLATES:
        raise ImportError_(f"unknown template {key}")
    return _tree(TEMPLATES[key]["spec"], locale)


def templates(locale: str) -> list[dict[str, Any]]:
    return [
        {
            "key": k,
            "name": t["name"]["fr" if locale == "fr" else "en"],
            "roles": len(t["spec"]),
            "about": t["about"]["fr" if locale == "fr" else "en"],
            # Parent index per role (None for the top), so the picker can draw a small preview.
            "shape": [
                None if parent is None else [r[0] for r in t["spec"]].index(parent)
                for _, parent, *_ in t["spec"]
            ],
        }
        for k, t in TEMPLATES.items()
    ]
