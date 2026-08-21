import json
import sqlite3
import sys

database_path = sys.argv[1]
connection = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True)
connection.row_factory = sqlite3.Row

try:
    tables = [row[0] for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    )]
    print("TABLES", tables)
    for table in ("labels", "label_templates"):
        if table not in tables:
            continue
        rows = connection.execute(f"SELECT * FROM {table}").fetchall()
        print("TABLE", table, "COUNT", len(rows))
        for row in rows:
            values = dict(row)
            raw = next((values.get(key) for key in (
                "structure_json", "structure", "document", "data", "template"
            ) if values.get(key) is not None), None)
            try:
                document = json.loads(raw) if isinstance(raw, str) else raw
            except (TypeError, json.JSONDecodeError):
                continue
            if not isinstance(document, dict) or not isinstance(document.get("elements"), list):
                continue
            output = {
                "id": values.get("id"),
                "name": values.get("name"),
                "labelType": values.get("label_type"),
                "canvas": document.get("canvas"),
                "elements": [{
                    "id": element.get("id"),
                    "type": element.get("type"),
                    "text": str(element.get("text", element.get("value", "")))[:100],
                    "fontFamily": element.get("fontFamily"),
                    "fontSize": element.get("fontSize"),
                    "fontWeight": element.get("fontWeight"),
                    "fontStyle": element.get("fontStyle"),
                    "textAlign": element.get("textAlign"),
                    "verticalAlign": element.get("verticalAlign"),
                    "lineHeight": element.get("lineHeight"),
                    "width": element.get("w"),
                    "height": element.get("h"),
                } for element in document["elements"]],
            }
            print(json.dumps(output, ensure_ascii=False, indent=2))
finally:
    connection.close()
