import json
import sqlite3
import sys
sys.stdout.reconfigure(encoding="utf-8")

database = sqlite3.connect(sys.argv[1])
tables = database.execute("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").fetchall()
printers = database.execute(
    "SELECT PrinterConfigurationId, Name, HostAddress, Port, ResolutionInDpmm "
    "FROM PrinterConfiguration ORDER BY PrinterConfigurationId"
).fetchall()
print(json.dumps({"tables": tables, "printers": printers}, ensure_ascii=False, indent=2))
