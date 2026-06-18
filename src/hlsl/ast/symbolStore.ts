'use strict';

import * as fs from 'fs';
import * as path from 'path';
import initSqlJs = require('sql.js');

/** A symbol row as stored in SQLite (no vscode types, so this is unit-testable). */
export interface SymbolRow {
    name: string;
    kind: number;
    container: string;
    uri: string;
    sl: number; sc: number; el: number; ec: number;
}

/**
 * SQLite-backed (WASM) symbol store. Rows live in SQLite's compact, off-V8-heap
 * WASM memory and are queried on demand, so steady-state heap stays low and flat
 * regardless of how many symbols the workspace contains. Only the (few) rows a
 * query returns are materialised as JS objects.
 *
 * sql.js initialisation is async; every read/write below is synchronous once
 * `init()` has resolved.
 */
export class SymbolStore {
    private db: initSqlJs.Database | null = null;

    async init(wasmDir: string, dbPath?: string): Promise<void> {
        const SQL = await initSqlJs({ locateFile: (file: string) => `${wasmDir}/${file}` });
        let initial: Uint8Array | null = null;
        if (dbPath) {
            try {
                if (fs.existsSync(dbPath)) { initial = new Uint8Array(fs.readFileSync(dbPath)); }
            } catch { /* ignore corrupt/locked cache */ }
        }
        try {
            this.db = new SQL.Database(initial);
        } catch {
            this.db = new SQL.Database(); // corrupt file -> start fresh
        }
        this.db.run(`
            CREATE TABLE IF NOT EXISTS symbols (
                name TEXT NOT NULL, kind INTEGER NOT NULL, container TEXT NOT NULL,
                uri TEXT NOT NULL, sl INTEGER, sc INTEGER, el INTEGER, ec INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
            CREATE INDEX IF NOT EXISTS idx_symbols_uri ON symbols(uri);
        `);
    }

    /**
     * Replace all symbols for a file in one transaction.
     *
     * The INSERT statement is prepared and freed *within* this call rather than
     * cached: `db.export()` (used by save()) closes any open prepared statement,
     * so a long-lived one would throw "Statement closed" on every write after
     * the first save. Writes are best-effort — a failure is logged and rolled
     * back, never thrown, so it can't break read-based navigation.
     */
    replaceFile(uri: string, rows: SymbolRow[]): void {
        if (!this.db) { return; }
        let stmt: initSqlJs.Statement | null = null;
        try {
            this.db.run('BEGIN');
            this.db.run('DELETE FROM symbols WHERE uri = ?', [uri]);
            stmt = this.db.prepare('INSERT INTO symbols (name, kind, container, uri, sl, sc, el, ec) VALUES (?,?,?,?,?,?,?,?)');
            for (const r of rows) {
                stmt.run([r.name, r.kind, r.container, r.uri, r.sl, r.sc, r.el, r.ec]);
            }
            stmt.free();
            stmt = null;
            this.db.run('COMMIT');
        } catch (e) {
            try { stmt?.free(); } catch { /* ignore */ }
            try { this.db.run('ROLLBACK'); } catch { /* ignore */ }
            console.error('SymbolStore.replaceFile failed:', e);
        }
    }

    removeFile(uri: string): void {
        if (!this.db) { return; }
        this.db.run('DELETE FROM symbols WHERE uri = ?', [uri]);
    }

    hasFile(uri: string): boolean {
        return this.queryRows('SELECT 1 FROM symbols WHERE uri = ? LIMIT 1', [uri]).length > 0;
    }

    byUri(uri: string): SymbolRow[] {
        return this.queryRows('SELECT name,kind,container,uri,sl,sc,el,ec FROM symbols WHERE uri = ?', [uri]);
    }

    byName(name: string): SymbolRow[] {
        return this.queryRows('SELECT name,kind,container,uri,sl,sc,el,ec FROM symbols WHERE name = ?', [name]);
    }

    /** Substring search (empty query = all), capped to keep result materialisation bounded. */
    search(query: string, limit: number): SymbolRow[] {
        if (!query) {
            return this.queryRows('SELECT name,kind,container,uri,sl,sc,el,ec FROM symbols LIMIT ?', [limit]);
        }
        return this.queryRows(
            "SELECT name,kind,container,uri,sl,sc,el,ec FROM symbols WHERE name LIKE ? ESCAPE '\\' LIMIT ?",
            [`%${escapeLike(query)}%`, limit]
        );
    }

    count(): number {
        if (!this.db) { return 0; }
        const res = this.db.exec('SELECT COUNT(*) FROM symbols');
        if (res.length && res[0].values.length) { return res[0].values[0][0] as number; }
        return 0;
    }

    save(dbPath: string): void {
        if (!this.db) { return; }
        try {
            fs.mkdirSync(path.dirname(dbPath), { recursive: true });
            fs.writeFileSync(dbPath, Buffer.from(this.db.export()));
        } catch { /* ignore */ }
    }

    dispose(): void {
        try { this.db?.close(); } catch { /* ignore */ }
        this.db = null;
    }

    private queryRows(sql: string, params: any[]): SymbolRow[] {
        if (!this.db) { return []; }
        const stmt = this.db.prepare(sql);
        const out: SymbolRow[] = [];
        try {
            stmt.bind(params);
            while (stmt.step()) {
                const v = stmt.get();
                out.push({
                    name: v[0], kind: v[1] as number, container: v[2],
                    uri: v[3], sl: v[4] as number, sc: v[5] as number, el: v[6] as number, ec: v[7] as number,
                } as SymbolRow);
            }
        } finally {
            stmt.free();
        }
        return out;
    }
}

function escapeLike(s: string): string {
    return s.replace(/[\\%_]/g, m => '\\' + m);
}
