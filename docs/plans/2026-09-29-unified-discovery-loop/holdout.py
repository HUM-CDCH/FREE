"""The loop's holdout: a catalogue the discovery method is never tuned on, for `measure.py ... holdout.py:holdout`.

160 entries marked `Nr. 301 –` (not `40.`), each followed by a nested find list of 1-4 numbered items on their own
lines (`1. Scherben.` `2. Knochen.` ...) and a `Verbleib:` line, under `Landkreis`/`Gemarkung` headings. The lines
are poured into two columns per book page, two book pages per PDF page, 10 lines per column, so entries run across
columns, book pages and PDF pages. Written 2026-09-29, before any method change of the loop.
"""

SITES = ["Birkenhain", "Steinfeld", "Mühlberg", "Rotenbach", "Kirchhof", "Sandgrube", "Lehmkuhle", "Eichwald",
         "Hohlweg", "Wiesengrund", "Burgwall", "Kiesgrube", "Moorwiese"]
KINDS = ["Grab", "Siedlung", "Einzelfund", "Hortfund", "Burg"]
FINDS = ["Scherben.", "Spinnwirtel.", "Knochen.", "Bronzenadel.", "Feuersteinklinge.", "Mahlstein."]
LANDKREISE = ["Saalfeld", "Nordheide", "Elbaue", "Vogtland"]
GEMARKUNGEN = ["Oberdorf", "Kleinhausen", "Zell", "Brunnrode", "Weidenau"]
SCHEMA = {"recordDescription": "One entry of an archaeological site catalogue.", "schemaNodes": [
    {"id": "s", "name": "site_name", "type": "string", "description": "the find place named at the start of the entry"},
    {"id": "f", "name": "fundart", "type": "string", "description": "the kind of site after Art:"},
    {"id": "v", "name": "verbleib", "type": "string", "description": "where the finds are kept"},
]}


def holdout(entries: int = 160, first: int = 301, lines_per_column: int = 10) -> dict:
    stream: list[str] = []
    truth: dict[str, dict] = {}
    for n in range(first, first + entries):
        if (n - first) % 12 == 0:
            if (n - first) % 36 == 0:
                stream.append(f"Landkreis {LANDKREISE[(n - first) // 36 % 4]}")
            stream.append(f"Gemarkung {GEMARKUNGEN[(n - first) // 12 % 5]}")
        site, kind, keeper = SITES[n % 13], KINDS[n % 5], f"Mus. Jena {n % 90}"
        stream.append(f"Nr. {n} – {site}, Flur {n % 9 + 2}. Art: {kind}. Funde:")
        stream += [f"{item}. {FINDS[(n + item) % 6]}" for item in range(1, n % 4 + 2)]
        stream.append(f"Verbleib: {keeper}.")
        truth[str(n)] = {"site_name": site, "fundart": kind, "verbleib": keeper}
    pages, book_page = [], 211
    while stream:
        units = []
        for side in range(2):
            crops = []
            for column in range(2):
                segments: list = [{"text": str(book_page), "label": "PageHeader"}] if column == 0 else []
                segments += stream[:lines_per_column]
                del stream[:lines_per_column]
                crops.append({"segments": segments})
            book_page += 1
            units.append({"index": 2 * len(pages) + 1 + side, "crops": crops})
        pages.append({"page": len(pages) + 1, "units": units})
    return {"case": {"description": "loop holdout catalogue", "pages": pages, "expected": {}}, "schema": SCHEMA,
            "truth": truth, "label": lambda label: label.removeprefix("Nr.").strip(" .–-")}
