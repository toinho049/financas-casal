import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
let ready = null;

// Cria as tabelas na primeira chamada (não precisa rodar migração manual)
function ensureSchema() {
  if (!ready) {
    ready = (async () => {
      await sql.query(`CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('entrada','saida')),
        description TEXT NOT NULL,
        amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
        category TEXT,
        date DATE NOT NULL,
        person TEXT,
        bill_id INTEGER,
        created_at TIMESTAMPTZ DEFAULT now()
      )`);
      await sql.query(`CREATE TABLE IF NOT EXISTS bills (
        id SERIAL PRIMARY KEY,
        description TEXT NOT NULL,
        amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
        due_date DATE NOT NULL,
        category TEXT,
        recurring BOOLEAN NOT NULL DEFAULT false,
        paid BOOLEAN NOT NULL DEFAULT false,
        paid_at DATE,
        created_at TIMESTAMPTZ DEFAULT now()
      )`);
      await sql.query(`CREATE TABLE IF NOT EXISTS investments (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT,
        invested NUMERIC(14,2) NOT NULL DEFAULT 0,
        current_value NUMERIC(14,2),
        date DATE,
        notes TEXT,
        updated_at TIMESTAMPTZ DEFAULT now()
      )`);
      await sql.query(`CREATE INDEX IF NOT EXISTS transactions_date_idx ON transactions(date)`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

export async function q(text, params = []) {
  await ensureSchema();
  return sql.query(text, params);
}
