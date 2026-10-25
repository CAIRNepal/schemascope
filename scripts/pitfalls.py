#!/usr/bin/env python3
"""Ontology pitfall tooling for SchemaScope (Python side of the quality checks).

  python3 scripts/pitfalls.py parse-oops tstOut.model.ttl   # summarise an OOPS! report (Turtle)
  python3 scripts/pitfalls.py scan ontology.owl             # rdflib scan for a subset of OOPS! pitfalls

Both print JSON: {"engine", "critical", "important", "minor", "pitfalls": [...]}, where the
counts are numbers of pitfall *types* at each importance level, as in the OOPS! catalogue
(https://oops.linkeddata.es/catalogue.jsp). The scan is a fallback for when OOPS! itself
cannot run; it implements only checks that are purely structural.
"""
import json
import sys
from collections import defaultdict

try:
    from rdflib import BNode, Graph, Literal, URIRef
    from rdflib.namespace import DC, DCTERMS, OWL, RDF, RDFS, SKOS
except ImportError:  # pragma: no cover
    print(json.dumps({"error": "rdflib not installed (pip install rdflib)"}))
    sys.exit(2)

OOPS = "http://oops.linkeddata.es/def#"
IAO_DEF = URIRef("http://purl.obolibrary.org/obo/IAO_0000115")
LEVEL = {"CRITICAL": "critical", "IMPORTANT": "important", "MINOR": "minor"}


def summary(engine, pitfalls):
    out = {"engine": engine, "critical": 0, "important": 0, "minor": 0, "pitfalls": pitfalls}
    for p in pitfalls:
        out[p["importance"]] += 1
    return out


def parse_oops(path):
    g = Graph()
    g.parse(path, format="turtle")
    pitfalls = []
    for p in g.subjects(RDF.type, URIRef(OOPS + "pitfall")):
        code = str(g.value(p, URIRef(OOPS + "hasCode")) or "")
        level = str(g.value(p, URIRef(OOPS + "hasImportanceLevel")) or "").upper()
        n = g.value(p, URIRef(OOPS + "hasNumberAffectedElements"))
        pitfalls.append({
            "code": code.split(" - ")[0].strip(),
            "name": str(g.value(p, URIRef(OOPS + "hasName")) or code),
            "importance": LEVEL.get(level, "minor"),
            "affected": int(n) if n is not None else None,
        })
    # Warnings (e.g. ontology not available) are not pitfalls.
    return summary("OOPS! (local Docker)", sorted(pitfalls, key=lambda x: x["code"]))


def load(path):
    g = Graph()
    for fmt in (None, "xml", "turtle", "nt"):
        try:
            g.parse(path, format=fmt) if fmt else g.parse(path)
            return g
        except Exception:
            g = Graph()
    raise ValueError("could not parse ontology (RDF/XML, Turtle or N-Triples expected)")


def scan(path):
    g = load(path)
    found = []

    def add(code, name, importance, affected):
        if affected:
            found.append({"code": code, "name": name, "importance": importance, "affected": affected})

    onts = list(g.subjects(RDF.type, OWL.Ontology))
    classes = {c for c in g.subjects(RDF.type, OWL.Class) if isinstance(c, URIRef)}
    obj_props = {p for p in g.subjects(RDF.type, OWL.ObjectProperty) if isinstance(p, URIRef)}
    data_props = {p for p in g.subjects(RDF.type, OWL.DatatypeProperty) if isinstance(p, URIRef)}
    ont_iri = str(onts[0]) if onts else None
    local = lambda x: ont_iri is None or str(x).startswith(ont_iri.rstrip("#/").rsplit("/", 1)[0])
    own_classes = {c for c in classes if local(c)}
    own_props = {p for p in obj_props | data_props if local(p)}

    # CRITICAL
    # P06 cycles in the class hierarchy (named classes only)
    sup = defaultdict(set)
    for s, o in g.subject_objects(RDFS.subClassOf):
        if isinstance(s, URIRef) and isinstance(o, URIRef) and s != o:
            sup[s].add(o)
    in_cycle, state = set(), {}

    def visit(n, stack):
        state[n] = 1
        stack.append(n)
        for m in sup.get(n, ()):
            if state.get(m) == 1:
                in_cycle.update(stack[stack.index(m):])
            elif m not in state:
                visit(m, stack)
        stack.pop()
        state[n] = 2

    sys.setrecursionlimit(100000)
    for n in list(sup):
        if n not in state:
            visit(n, [])
    add("P06", "Including cycles in a class hierarchy", "critical", len(in_cycle))
    # P19 multiple domains or ranges (interpreted as intersection; usually a modelling error)
    multi = [p for p in own_props if len(set(g.objects(p, RDFS.domain))) > 1 or len(set(g.objects(p, RDFS.range))) > 1]
    add("P19", "Defining multiple domains or ranges in properties", "critical", len(multi))
    # P39 ambiguous namespace: no ontology IRI to resolve terms against
    add("P39", "Ambiguous namespace", "critical", 1 if not onts or all(isinstance(o, BNode) for o in onts) else 0)

    # IMPORTANT
    add("P38", "No OWL ontology declaration", "important", 0 if onts else 1)
    if onts:
        lic = any(g.value(onts[0], p) is not None for p in (DCTERMS.license, DC.rights, DCTERMS.rights, URIRef("http://creativecommons.org/ns#license"), URIRef("http://schema.org/license")))
        add("P41", "No license declared", "important", 0 if lic else 1)
    declared = classes | {c for c in g.subjects(RDF.type, RDFS.Class)}
    used_as_class = {o for o in g.objects(None, RDFS.subClassOf) if isinstance(o, URIRef)} | {s for s in g.subjects(RDFS.subClassOf, None) if isinstance(s, URIRef)}
    untyped = {c for c in used_as_class - declared if c != OWL.Thing and local(c)}
    add("P34", "Untyped class", "important", len(untyped))
    declared_props = obj_props | data_props | set(g.subjects(RDF.type, OWL.AnnotationProperty)) | set(g.subjects(RDF.type, RDF.Property))
    used_props = {o for o in g.objects(None, OWL.onProperty) if isinstance(o, URIRef)}
    add("P35", "Untyped property", "important", len({p for p in used_props - declared_props if local(p)}))
    no_dr = [p for p in obj_props if local(p) and (g.value(p, RDFS.domain) is None or g.value(p, RDFS.range) is None)]
    add("P11", "Missing domain or range in properties", "important", len(no_dr))
    has_disjoint = any(True for _ in g.triples((None, OWL.disjointWith, None))) or any(True for _ in g.subjects(RDF.type, OWL.AllDisjointClasses))
    add("P10", "Missing disjointness", "important", 0 if has_disjoint or len(own_classes) < 2 else 1)

    # MINOR
    label_props = (RDFS.label, SKOS.prefLabel)
    def_props = (RDFS.comment, IAO_DEF, SKOS.definition, DCTERMS.description)
    unannotated = [c for c in own_classes if not any(g.value(c, p) for p in label_props) or not any(g.value(c, p) for p in def_props)]
    add("P08", "Missing annotations", "minor", len(unannotated))
    inv_missing = [p for p in obj_props if local(p) and g.value(p, OWL.inverseOf) is None and (None, OWL.inverseOf, p) not in g]
    add("P13", "Inverse relationships not explicitly declared", "minor", len(inv_missing))

    out = summary("SchemaScope Python scan (OOPS! pitfall subset)", found)
    out["checked"] = ["P06", "P19", "P39", "P38", "P41", "P34", "P35", "P11", "P10", "P08", "P13"]
    out["classes"] = len(own_classes)
    return out


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in ("parse-oops", "scan"):
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    try:
        print(json.dumps(parse_oops(sys.argv[2]) if sys.argv[1] == "parse-oops" else scan(sys.argv[2])))
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        sys.exit(1)
