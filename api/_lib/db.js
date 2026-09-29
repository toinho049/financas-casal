import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
let ready = null;

const DDL = [
  `CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('entrada','saida')),
    description TEXT NOT NULL,
    amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
    category TEXT,
    date DATE NOT NULL,
    person TEXT,
    bill_id INTEGER,
    created_at TIMESTAMPTZ DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS bills (
    id SERIAL PRIMARY KEY,
    description TEXT NOT NULL,
    amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
    due_date DATE NOT NULL,
    category TEXT,
    recurring BOOLEAN NOT NULL DEFAULT false,
    paid BOOLEAN NOT NULL DEFAULT false,
    paid_at DATE,
    created_at TIMESTAMPTZ DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS investments (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT,
    invested NUMERIC(14,2) NOT NULL DEFAULT 0,
    current_value NUMERIC(14,2),
    date DATE,
    notes TEXT,
    updated_at TIMESTAMPTZ DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS transactions_date_idx ON transactions(date)`,
];

// Várias funções podem subir ao mesmo tempo (o painel faz 3 requisições em paralelo).
// A trava de sessão garante que só uma cria as tabelas; as outras esperam e seguem.
async function createSchema() {
  await sql.transaction([
    sql.query('SELECT pg_advisory_xact_lock(727274)'),
    ...DDL.map((s) => sql.query(s)),
  ]);
}

function ensureSchema() {
  if (!ready) {
    ready = (async () => {
      try {
        await createSchema();
      } catch (e) {
        // 23505/42P07 = outra instância criou ao mesmo tempo; tenta de novo (agora já existe)
        if (e.code === '23505' || e.code === '42P07') await createSchema();
        else throw e;
      }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

export async function q(text, params = []) {
  await ensureSchema();
  return sql.query(text, params);
}
