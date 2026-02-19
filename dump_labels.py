import sqlite3
import os
import json

db_path = os.path.expanduser('~/AppData/Roaming/electron-labelpilot/client_data.db')
if not os.path.exists(db_path):
    print(f"DB not found at {db_path}")
    exit(1)

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

try:
    cursor.execute("SELECT id, name, structure FROM labels")
    rows = cursor.fetchall()
    labels = []
    for row in rows:
        labels.append({
            "id": row[0],
            "name": row[1],
            "structure": json.loads(row[2])
        })
    
    with open('labels_db_dump.json', 'w', encoding='utf-8') as f:
        json.dump(labels, f, indent=2, ensure_ascii=False)
    print(f"Successfully dumped {len(labels)} labels to labels_db_dump.json")
except Exception as e:
    print(e)
finally:
    conn.close()
