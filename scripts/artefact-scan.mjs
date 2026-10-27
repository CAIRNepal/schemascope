// Read an ontology file for what it imports and whose terms it uses, so I3 and upper-ontology alignment
// don't depend on OLS or Bioregistry listing the imports. Streams the file, so size isn't a problem;
// only the first ARTEFACT_SCAN_MB (default 500) are read, which covers the header and a large sample of terms.
import { createReadStream } from "node:fs";

// Well-known namespaces that aren't OBO PURLs (OBO ones are recognised by their PREFIX_ pattern).
const KNOWN_NS = {
  "http://www.ontologydesignpatterns.org/ont/dul/dul.owl#": "dolce",
  "http://www.loa-cnr.it/ontologies/dolce-lite.owl#": "dolce",
  "http://www.onto-med.de/ontologies/gfo.owl#": "gfo",
  "http://purl.org/nemo/gufo#": "gufo",
  "http://www.w3.org/2004/02/skos/core#": "skos",
  "http://purl.org/dc/terms/": "dcterms",
  "http://purl.org/dc/elements/1.1/": "dc",
  "http://xmlns.com/foaf/0.1/": "foaf",
  "http://www.w3.org/ns/prov#": "prov",
  "http://schema.org/": "schema",
  "https://schema.org/": "schema",
  "http://www.w3.org/2006/time#": "time",
  "http://www.w3.org/ns/dcat#": "dcat",
  "http://qudt.org/schema/qudt/": "qudt",
};
const nsOf = (iri) => {
  const i = Math.max(iri.lastIndexOf("#"), iri.lastIndexOf("/"));
  return i > 8 ? iri.slice(0, i + 1).toLowerCase() : null;
};
const oboImport = (iri) => iri.match(/^https?:\/\/purl\.obolibrary\.org\/obo\/([a-z][a-z0-9_]*?)(?:[./]|$)/i)?.[1]?.toLowerCase() || null;

// A map from namespace (lower case) to catalog id, from the catalog's LOV namespaces plus the well-known ones.
export function namespaceMap(catalog) {
  const map = new Map(Object.entries(KNOWN_NS));
  for (const e of catalog) {
    const ns = e.registryStats?.lov?.namespace;
    if (ns && !map.has(ns.toLowerCase())) map.set(ns.toLowerCase(), e.id);
  }
  return map;
}

// self: the ontology's own ids; selfHosts: its own hosts (its download and homepage), whose imports are its own modules.
export async function scanArtefact(file, { nsMap, self = [], selfHosts = [], maxMb = Number(process.env.ARTEFACT_SCAN_MB || 500) } = {}) {
  const selfIds = new Set(self.filter(Boolean).map((x) => String(x).toLowerCase()));
  const importIris = new Set();
  const terms = new Map(); // id -> Set of distinct term IRIs (capped)
  const note = (id, term) => {
    if (!id || selfIds.has(id)) return;
    let s = terms.get(id);
    if (!s) terms.set(id, (s = new Set()));
    if (s.size < 50) s.add(term);
  };
  const IMPORT_RES = [
    /owl:imports\s+rdf:resource\s*=\s*["']([^"']+)["']/g, // RDF/XML
    /<owl:imports>\s*([^<\s]+)\s*<\/owl:imports>/g,
    /<Import>\s*([^<\s]+)\s*<\/Import>/g, // OWL/XML
    /\bImport\(\s*<([^>]+)>\s*\)/g, // functional syntax
    /^import:\s*(\S+)/gm, // OBO format
    /"(?:owl:imports|http:\/\/www\.w3\.org\/2002\/07\/owl#imports)"\s*:\s*\{?\s*"?@?i?d?"?\s*:?\s*"([^"]+)"/g, // JSON-LD
  ];
  const TTL_IMPORT = /(?:owl:imports|<http:\/\/www\.w3\.org\/2002\/07\/owl#imports>)\s+((?:<[^>]+>\s*,?\s*)+)/g; // Turtle / N-Triples, incl. lists
  const OBO_TERM = /purl\.obolibrary\.org\/obo\/([A-Za-z][A-Za-z0-9]*)_([A-Za-z0-9]+)/g;
  const OBO_CURIE = /(?:^|[\s\[,])([A-Z][A-Za-z]{1,15}):(\d{5,})\b/gm; // is_a: BFO:0000001 in .obo files
  const IRI = /https?:\/\/[^\s"'<>()\[\]{},]+[#/][A-Za-z_][^\s"'<>()\[\]{},#/]*/g;

  let bytes = 0, tail = "";
  const limit = maxMb * 1e6;
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  for await (const chunk of stream) {
    const text = tail + chunk;
    for (const re of IMPORT_RES) for (const m of text.matchAll(re)) importIris.add(m[1]);
    for (const m of text.matchAll(TTL_IMPORT)) for (const x of m[1].matchAll(/<([^>]+)>/g)) importIris.add(x[1]);
    for (const m of text.matchAll(OBO_TERM)) note(m[1].toLowerCase(), `${m[1]}_${m[2]}`);
    for (const m of text.matchAll(OBO_CURIE)) note(m[1].toLowerCase(), `${m[1]}:${m[2]}`);
    for (const m of text.matchAll(IRI)) {
      if (m[0].includes("purl.obolibrary.org/obo/")) continue;
      const id = nsMap?.get(nsOf(m[0]));
      if (id) note(id, m[0]);
    }
    bytes += Buffer.byteLength(chunk);
    tail = text.slice(-2048); // keep the end so matches split across chunks aren't lost (duplicates are harmless)
    if (bytes >= limit) {
      stream.destroy();
      break;
    }
  }
  // An import that isn't a known vocabulary still counts, keyed by its address, unless it's on the ontology's own site.
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return null; } };
  const own = new Set(selfHosts.map(hostOf).filter(Boolean));
  const keyOf = (iri) => oboImport(iri) || nsMap?.get(nsOf(iri)) || nsMap?.get(iri.toLowerCase().replace(/[#/]?$/, "#")) || nsMap?.get(iri.toLowerCase().replace(/[#/]?$/, "/")) ||
    (own.has(hostOf(iri)) ? null : `${hostOf(iri)}${new URL(iri).pathname.replace(/\.(owl|ttl|rdf|xml|jsonld|nt|n3)$/i, "").replace(/\/$/, "")}`.toLowerCase());
  const imports = [...importIris].filter((iri) => /^https?:\/\//.test(iri)).map((iri) => ({ iri, id: keyOf(iri), own: own.has(hostOf(iri)) })).filter((x) => x.id && !selfIds.has(x.id));
  // "Uses" a vocabulary when at least 3 distinct terms from it appear.
  const uses = Object.fromEntries([...terms].filter(([, s]) => s.size >= 3).map(([id, s]) => [id, s.size]));
  return { imports, uses, scannedMb: Math.round(bytes / 1e6), truncated: bytes >= limit, scannedAt: new Date().toISOString() };
}
