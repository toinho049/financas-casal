import { neon } from '@neondatabase/serverless';
import { hashPassword } from './password.js';

const sql = neon(process.env.DATABASE_URL);
let ready = null;

const DDL = [
  `CREATE TABLE IF NOT EXISTS accounts (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    plan TEXT,
    paid_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    created_at TIMESTAMPTZ DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    plan TEXT,
    amount NUMERIC(12,2),
    status TEXT,
    credited BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )`,
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
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS account_id INTEGER`,
  `ALTER TABLE bills ADD COLUMN IF NOT EXISTS account_id INTEGER`,
  `ALTER TABLE investments ADD COLUMN IF NOT EXISTS account_id INTEGER`,
  `CREATE INDEX IF NOT EXISTS transactions_acc_idx ON transactions(account_id, date)`,
  `CREATE INDEX IF NOT EXISTS bills_acc_idx ON bills(account_id)`,
  `CREATE INDEX IF NOT EXISTS investments_acc_idx ON investments(account_id)`,
  `CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN NOT NULL DEFAULT false
  )`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
    id SERIAL PRIMARY KEY,
    key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS login_attempts_idx ON login_attempts(key, created_at)`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS campaigns (
    code TEXT PRIMARY KEY,
    days INTEGER NOT NULL CHECK (days BETWEEN 1 AND 3650),
    active BOOLEAN NOT NULL DEFAULT true,
    uses INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
  )`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_at TIMESTAMPTZ`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS campaign TEXT`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS subscription_id TEXT`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS subscription_status TEXT`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS subscription_plan TEXT`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  )`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS installment_group TEXT`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS installment_no INTEGER`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS installment_total INTEGER`,
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS import_key TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS transactions_import_idx ON transactions(account_id, import_key) WHERE import_key IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS budgets (
    id SERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    created_at TIMESTAMPTZ DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS budgets_acc_cat_idx ON budgets(account_id, lower(category))`,
  `CREATE TABLE IF NOT EXISTS push_log (
    sub_id INTEGER NOT NULL,
    day DATE NOT NULL,
    PRIMARY KEY (sub_id, day)
  )`,
];

// Usuários antigos da variável USERS ("nome:senha;nome:senha") viram a conta
// principal, com acesso vitalício. Os dados que já existiam passam para ela.
function legacyUsers() {
  return (process.env.USERS || '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.includes(':'))
    .map((s, i) => {
      const k = s.indexOf(':');
      const login = s.slice(0, k).trim().toLowerCase();
      return { login, pass: s.slice(k + 1), role: i === 0 ? 'owner' : 'member' };
    });
}

const LEGACY_ACC = `(SELECT id FROM accounts WHERE plan = 'vitalicio' ORDER BY id LIMIT 1)`;

function migrationQueries() {
  const legacy = legacyUsers();
  return [
    sql.query(
      `INSERT INTO accounts (name, plan, paid_until)
       SELECT 'Conta principal', 'vitalicio', '2099-12-31'
       WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE plan = 'vitalicio')
         AND ($1::boolean
              OR EXISTS (SELECT 1 FROM transactions WHERE account_id IS NULL)
              OR EXISTS (SELECT 1 FROM bills WHERE account_id IS NULL)
              OR EXISTS (SELECT 1 FROM investments WHERE account_id IS NULL))`,
      [legacy.length > 0]
    ),
    sql.query(`UPDATE transactions SET account_id = ${LEGACY_ACC} WHERE account_id IS NULL`),
    sql.query(`UPDATE bills SET account_id = ${LEGACY_ACC} WHERE account_id IS NULL`),
    sql.query(`UPDATE investments SET account_id = ${LEGACY_ACC} WHERE account_id IS NULL`),
    ...legacy.map((u) =>
      sql.query(
        `INSERT INTO users (account_id, email, name, pass_hash, role)
         SELECT id, $1, $1, $2, $3 FROM accounts WHERE plan = 'vitalicio' ORDER BY id LIMIT 1
         ON CONFLICT (email) DO NOTHING`,
        [u.login, hashPassword(u.pass), u.role]
      )
    ),
  ];
}

// Várias funções podem subir ao mesmo tempo (o painel faz 3 requisições em paralelo).
// A trava garante que só uma cria/migra; as outras esperam e seguem.
async function createSchema() {
  await sql.transaction([
    sql.query('SELECT pg_advisory_xact_lock(727274)'),
    ...DDL.map((s) => sql.query(s)),
    ...migrationQueries(),
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

// Configurações gerais guardadas no banco (editáveis pelo Admin)
export async function getSetting(key, fallback = null) {
  const [r] = await q(`SELECT value FROM settings WHERE key = $1`, [key]);
  return r ? r.value : fallback;
}

export async function setSetting(key, value) {
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)]
  );
}
