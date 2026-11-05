#!/usr/bin/env python3
"""Diagnose SQLite corruption: which pages/tables are damaged, which tables readable."""
import sqlite3, sys, json

DB = sys.argv[1] if len(sys.argv) > 1 else "/home/z/my-project/db/custom.db"
con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
cur = con.cursor()

print("=== quick_check (first 40 problems) ===")
try:
    rows = cur.execute("PRAGMA quick_check(40)").fetchall()
    for r in rows:
        print(" ", r[0][:150])
except Exception as e:
    print("quick_check failed:", e)

print("\n=== per-table readability probe ===")
tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()]
for t in tables:
    try:
        n = cur.execute(f"SELECT COUNT(*) FROM \"{t}\"").fetchone()[0]
        print(f"  OK      {t:20} rows={n}")
    except Exception as e:
        # try to count readable rows via rowid probing
        readable = 0
        maxid = 0
        try:
            maxid = cur.execute(f"SELECT MAX(rowid) FROM \"{t}\"").fetchone()[0] or 0
            step = max(1, maxid // 500)
            for lo in range(1, maxid + 1, step):
                hi = lo + step - 1
                try:
                    readable += cur.execute(f"SELECT COUNT(*) FROM \"{t}\" WHERE rowid BETWEEN {lo} AND {hi}").fetchone()[0]
                except Exception:
                    pass
        except Exception:
            pass
        print(f"  CORRUPT {t:20} readable≈{readable}/{maxid} ({e.__class__.__name__})")
con.close()
