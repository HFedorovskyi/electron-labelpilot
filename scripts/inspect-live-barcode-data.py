import json
import sqlite3
import sys

con = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
con.row_factory = sqlite3.Row
rows = lambda sql, args=(): [dict(row) for row in con.execute(sql, args)]
report = {
    "nomenclature": rows("SELECT * FROM nomenclature WHERE id = 275 OR article = '3002'"),
    "recentPacks": rows("SELECT id, number, nomenclature_id, barcode_value, weight_netto, created_at FROM pack WHERE nomenclature_id = 275 ORDER BY id DESC LIMIT 5"),
    "printJobs": rows("SELECT * FROM print_jobs WHERE nomenclature_id = 275 OR nomenclature_article = '3002' ORDER BY id DESC LIMIT 5"),
    "barcodes": rows("SELECT * FROM barcodes ORDER BY id"),
}
labels = rows("SELECT id, name, structure FROM labels ORDER BY id")
report["matchingLabelBarcodes"] = []
for label in labels:
    try:
        structure = json.loads(label["structure"])
    except Exception:
        continue
    for element in structure.get("elements", []):
        if element.get("type") == "barcode":
            report["matchingLabelBarcodes"].append({
                "labelId": label["id"], "labelName": label["name"],
                "labelType": structure.get("canvas", {}).get("labelType"),
                "element": {key: element.get(key) for key in ("id", "value", "barcodeType", "templateId", "error")},
            })
with open(sys.argv[2], "w", encoding="utf-8") as stream:
    json.dump(report, stream, ensure_ascii=False, indent=2)
con.close()