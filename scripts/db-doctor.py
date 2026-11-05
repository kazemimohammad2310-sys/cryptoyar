#!/usr/bin/env python3
"""
db-doctor.py — SQLite corruption self-repair for CryptoYar.

Strategy: corruption is almost always confined to a few pages of the hottest
tables (TickerSnapshot etc.). We rebuild the database into a NEW file:
  1. read the full DDL (tables + indexes) from sqlite_master of the old file
  2. copy every READABLE row of every table (corrupt tables get rowid-range
     chunked reads so intact rows survive)
  3. atomically replace the old file, then quick_check the result
Meaningful data survives; hot caches (tickers) just repopulate from the API.

Usage: python3 db-doctor.py /path/to/custom.db [--check-only]
Exit codes: 0 = healthy (or repaired), 1 = still corrupt, 2 = fatal error.
"""
import sqlite3
import sys
import os
import tempfile

CHUNK = 2000  # rowid-range probe width


def readable_tables(con):
    rows = con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    return [r[0] for r in rows]


def is_corrupt(db_path):
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        cur = con.execute("PRAGMA quick_check(1)")
        rows = cur.fetchall()
        con.close()
        return not (rows and rows[0][0] == "ok")
    except sqlite3.DatabaseError:
        return True


def ddl_of(con):
    stmts = []
    for sql, in con.execute("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL"):
        stmts.append(sql)
    return stmts


def copy_table(src, dst, table):
    cols = [r[1] for r in src.execute(f'PRAGMA table_info("{table}")')]
    collist = ", ".join(f'"{c}"' for c in cols)
    try:
        maxid = src.execute(f'SELECT MAX(rowid) FROM "{table}"').fetchone()[0] or 0
    except sqlite3.DatabaseError:
        return 0, "unreadable"
    copied = 0
    skipped = 0
    ph = ", ".join("?" for _ in cols)
    for lo in range(1, maxid + CHUNK, CHUNK):
        hi = lo + CHUNK - 1
        try:
            rows = src.execute(
                f'SELECT rowid, {collist} FROM "{table}" WHERE rowid BETWEEN {lo} AND {hi}'
            ).fetchall()
            dst.executemany(
                f'INSERT INTO "{table}" (rowid, {collist}) VALUES ({", ".join("?" for _ in range(len(cols) + 1))})',
                rows,
            )
            copied += len(rows)
        except sqlite3.DatabaseError:
            # narrow to single rows so one bad page doesn't lose the whole chunk
            for rid in range(lo, min(hi, maxid) + 1):
                try:
                    row = src.execute(
                        f'SELECT rowid, {collist} FROM "{table}" WHERE rowid={rid}'
                    ).fetchone()
                    if row:
                        dst.execute(
                            f'INSERT INTO "{table}" (rowid, {collist}) VALUES ({", ".join("?" for _ in range(len(cols) + 1))})',
                            row,
                        )
                        copied += 1
                except sqlite3.DatabaseError:
                    skipped += 1
    return copied, f"skipped={skipped}"


def repair(db_path):
    src = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    ddl = ddl_of(src)
    fd, tmp = tempfile.mkstemp(suffix=".db", dir=os.path.dirname(db_path) or ".")
    os.close(fd)
    os.remove(tmp)  # sqlite will create it fresh
    dst = sqlite3.connect(tmp)
    for stmt in ddl:
        try:
            dst.execute(stmt)
        except sqlite3.DatabaseError as e:
            print(f"  DDL skipped: {e}")
    summary = []
    for t in readable_tables(src):
        copied, note = copy_table(src, dst, t)
        summary.append(f"{t}:{copied}{(' ' + note) if 'skipped=' in note and not note.endswith('skipped=0') else ''}")
    dst.commit()
    ck = dst.execute("PRAGMA quick_check(1)").fetchone()[0]
    dst.close()
    src.close()
    if ck != "ok":
        os.remove(tmp)
        print(f"REPAIR FAILED — rebuilt file still corrupt ({ck})")
        return 1
    # atomic replace
    os.replace(tmp, db_path)
    # fresh WAL sidecars
    for ext in ("-wal", "-shm"):
        p = db_path + ext
        if os.path.exists(p):
            os.remove(p)
    print(f"REPAIR OK — {' | '.join(summary)}")
    return 0


def main():
    db_path = sys.argv[1] if len(sys.argv) > 1 else "db/custom.db"
    check_only = "--check-only" in sys.argv
    if not os.path.exists(db_path):
        print(f"db-doctor: file not found: {db_path}")
        return 2
    if not is_corrupt(db_path):
        print("DB OK — no repair needed")
        return 0
    if check_only:
        print("DB CORRUPT — repair needed")
        return 1
    print(f"DB CORRUPT — rebuilding {db_path} ...")
    return repair(db_path)


if __name__ == "__main__":
    sys.exit(main())
