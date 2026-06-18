// Minimal ambient types for the subset of sql.js we use (the package ships no types).
declare module 'sql.js' {
    namespace initSqlJs {
        interface Statement {
            bind(params?: any[]): boolean;
            step(): boolean;
            get(params?: any[]): any[];
            run(params?: any[]): void;
            reset(): void;
            free(): boolean;
        }
        interface Database {
            run(sql: string, params?: any[]): void;
            exec(sql: string, params?: any[]): { columns: string[]; values: any[][] }[];
            prepare(sql: string): Statement;
            export(): Uint8Array;
            close(): void;
        }
        interface SqlJsStatic {
            Database: { new(data?: Uint8Array | null): Database };
        }
        interface InitOptions {
            locateFile?: (file: string) => string;
        }
    }
    function initSqlJs(config?: initSqlJs.InitOptions): Promise<initSqlJs.SqlJsStatic>;
    export = initSqlJs;
}
