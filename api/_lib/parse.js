// Entende mensagens como "gastei 100 reais em alimentação", "uber 23,50 no crédito",
// "recebi 5000 salário", "mercado 250 ontem", "tv 1200 em 10x nubank".
// Sem inteligência artificial: regras simples, rápidas e de graça.

export const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

const DEFAULT_SAIDA = ['Moradia', 'Aluguel', 'Mercado', 'Alimentação', 'Transporte', 'Combustível', 'Contas da casa', 'Internet/Telefone',
  'Saúde', 'Educação', 'Lazer', 'Vestuário', 'Cartão de crédito', 'Pets', 'Presentes', 'Impostos', 'Outros'];
const DEFAULT_ENTRADA = ['Salário', 'Freelance', '13º / Férias', 'Rendimentos', 'Reembolso', 'Venda', 'Outros'];

// palavra-chave (sem acento) -> categoria padrão
const SYN = [
  [/\b(alimentacao|comida|lanche|lanches|ifood|i food|restaurante|almoco|almocei|janta|jantar|jantei|pizza|hamburguer|burguer|delivery|cafe|marmita|sorvete|acai|pastel|churrasco)\b/, 'Alimentação'],
  [/\b(mercado|supermercado|feira|acougue|hortifruti|atacadao|assai|sacolao|compras do mes|rancho)\b/, 'Mercado'],
  [/\b(gasolina|combustivel|posto|etanol|alcool|diesel|abasteci|abastecer|abastecimento)\b/, 'Combustível'],
  [/\b(uber|99|taxi|onibus|metro|passagem|estacionamento|pedagio|transporte|mecanico|oficina|lavacao|lava jato)\b/, 'Transporte'],
  [/\b(aluguel)\b/, 'Aluguel'],
  [/\b(condominio|moradia|iptu da casa|reforma|material de construcao)\b/, 'Moradia'],
  [/\b(luz|energia|agua|gas|conta de luz|conta de agua|contas da casa)\b/, 'Contas da casa'],
  [/\b(internet|telefone|celular|plano do celular|recarga|net|claro|vivo|tim|oi fibra|netflix|spotify|streaming|assinatura)\b/, 'Internet/Telefone'],
  [/\b(farmacia|remedio|remedios|medico|consulta|dentista|exame|exames|hospital|plano de saude|academia|saude|psicologo|terapia)\b/, 'Saúde'],
  [/\b(escola|curso|faculdade|livro|livros|material escolar|mensalidade|educacao)\b/, 'Educação'],
  [/\b(cinema|bar|cerveja|show|passeio|viagem|hotel|lazer|festa|balada|jogo|ingresso)\b/, 'Lazer'],
  [/\b(roupa|roupas|tenis|sapato|calca|camisa|camiseta|blusa|vestido|vestuario|bermuda)\b/, 'Vestuário'],
  [/\b(pet|pets|racao|veterinario|petshop|pet shop|cachorro|gato)\b/, 'Pets'],
  [/\b(presente|presentes|aniversario)\b/, 'Presentes'],
  [/\b(imposto|impostos|ipva|iptu|taxa|multa|das|darf)\b/, 'Impostos'],
  [/\b(fatura|cartao de credito)\b/, 'Cartão de crédito'],
];
const SYN_IN = [
  [/\b(salario|pagamento do mes|vale|adiantamento|holerite)\b/, 'Salário'],
  [/\b(freela|freelance|bico|servico|job|projeto)\b/, 'Freelance'],
  [/\b(13|decimo|ferias)\b/, '13º / Férias'],
  [/\b(rendimento|rendimentos|dividendo|dividendos|juros|cdb|tesouro)\b/, 'Rendimentos'],
  [/\b(reembolso|estorno|devolucao|devolveram)\b/, 'Reembolso'],
  [/\b(venda|vendi|vendas)\b/, 'Venda'],
];

const IN_WORDS = /\b(recebi|recebido|recebimento|ganhei|entrou|entrada|caiu|salario|vendi|venda|reembolso|estorno|rendimento|rendeu|me pagaram|pagaram)\b/;
const FILLER = new Set(('gastei gasto gastamos paguei pago pagamos comprei compra comprei compramos recebi recebido ganhei entrou caiu foi foram de do da dos das em no na nos nas com pra pro para por o a os as um uma reais real r$ rs conto contos pila pilas '
  + 'hoje ontem anteontem dei gastos dia pix debito credito cartao dinheiro especie boleto vista a vista avista vezes parcelas parcelado parcelada x e meu minha nosso nossa lancar lanca lança anota anotar valor').split(' '));

const METHOD_RE = [
  [/\bpix\b/, 'Pix'],
  [/\b(debito)\b/, 'Cartão de débito'],
  [/\b(credito|cartao de credito|no cartao|parcelad[oa]|\d{1,2}\s*x\b|em \d{1,2} (vezes|parcelas))\b/, 'Cartão de crédito'],
  [/\b(dinheiro|especie|em maos)\b/, 'Dinheiro'],
  [/\b(boleto)\b/, 'Boleto'],
];

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// Valor em reais: "100", "100,50", "1.250,00", "1250.5", "R$ 80", "2 mil", "1,5k"
function findAmount(t) {
  const re = /(r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)(\s*(?:mil\b|k\b))?(\s*(?:reais|real|conto|contos|pila|pilas)\b)?/g;
  let m, best = null;
  while ((m = re.exec(t))) {
    const before = t.slice(Math.max(0, m.index - 4), m.index), after = t.slice(m.index + m[0].length, m.index + m[0].length + 8);
    if (/dia\s*$/.test(before)) continue;                         // "dia 5"
    if (/^\s*(x\b|vezes|parcela)/.test(after) && !m[1]) continue;  // "10x"
    if (/^\s*\/\s*\d/.test(after) || /\d\s*\/\s*$/.test(before)) continue;  // datas 05/10
    if (/^\s*(h|hs|horas|min)\b/.test(after)) continue;
    let raw = m[2];
    if (raw.includes(',')) raw = raw.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(raw)) raw = raw.replace(/\./g, '');
    let v = Number(raw);
    if (m[3]) v *= 1000;
    if (!(v > 0) || v > 1e8) continue;
    const score = (m[1] ? 4 : 0) + (m[4] ? 3 : 0) + (m[3] ? 2 : 0) + (raw.includes('.') ? 1 : 0);
    if (!best || score > best.score) best = { v: Math.round(v * 100) / 100, score, text: m[0] };
  }
  return best;
}

function findDate(t, now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (/\banteontem\b/.test(t)) { d.setUTCDate(d.getUTCDate() - 2); return iso(d); }
  if (/\bontem\b/.test(t)) { d.setUTCDate(d.getUTCDate() - 1); return iso(d); }
  let m = t.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?\b/);
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : d.getUTCFullYear();
    const x = new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[1])));
    if (x.getUTCDate() === Number(m[1])) { if (!m[3] && x > d) x.setUTCFullYear(y - 1); return iso(x); }
  }
  m = t.match(/\bdia\s+(\d{1,2})\b/);
  if (m) {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), Number(m[1])));
    if (x.getUTCDate() === Number(m[1])) { if (x > d) x.setUTCMonth(x.getUTCMonth() - 1); return iso(x); }
  }
  return iso(d);
}

// cats = categorias que a conta já usa; cards = [{id, name}]
export function parseMessage(text, { now = new Date(), cats = [], cards = [] } = {}) {
  const original = String(text || '').trim().slice(0, 300);
  const t = ' ' + norm(original).replace(/[!?;]+/g, ' ') + ' ';
  const amount = findAmount(t);
  if (!amount) return null;

  const type = IN_WORDS.test(t) ? 'entrada' : 'saida';
  const tc = t.replace(amount.text, ' ');   // sem o valor (ex.: "99 reais" não vira "99 táxi")
  let method = null;
  for (const [re, m] of METHOD_RE) if (re.test(tc)) { method = m; break; }

  // Cartão citado pelo nome ("nubank", "itaú")
  let card = null;
  for (const c of cards) {
    const n = norm(c.name);
    if (n && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)) { card = c; break; }
  }
  if (card && type === 'saida') method = 'Cartão de crédito';
  if (method === 'Cartão de crédito' && !card && cards.length === 1) card = cards[0];
  if (type === 'entrada' && method && method !== 'Pix' && method !== 'Dinheiro') method = null;

  let installments = 1;
  const pm = t.match(/\b(\d{1,2})\s*x\b/) || t.match(/\bem (\d{1,2}) (?:vezes|parcelas)\b/);
  if (pm && type === 'saida') { const n = Number(pm[1]); if (n >= 2 && n <= 48) { installments = n; method = 'Cartão de crédito'; } }

  // Categoria: primeiro as que a conta já usa (nome aparece na frase), depois sinônimos
  const own = [...new Set(cats.filter(Boolean))].sort((a, b) => b.length - a.length);
  let category = own.find((c) => { const n = norm(c); return n.length >= 3 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\b`).test(tc); }) || null;
  if (!category) {
    const hit = (type === 'entrada' ? SYN_IN : SYN).find(([re]) => re.test(tc));
    if (hit) category = own.find((c) => norm(c) === norm(hit[1])) || hit[1];
  }

  // Descrição: o que sobra da frase (sem valor, datas, forma de pagamento e palavras de ligação)
  let rest = ' ' + norm(original) + ' ';
  rest = rest.replace(amount.text.trim(), ' ').replace(/\b\d{1,2}\s*\/\s*\d{1,2}(\s*\/\s*\d{2,4})?\b/g, ' ').replace(/\bdia\s+\d{1,2}\b/g, ' ')
    .replace(/\b\d{1,2}\s*x\b/g, ' ').replace(/\bem \d{1,2} (vezes|parcelas)\b/g, ' ');
  if (card) rest = rest.replace(new RegExp(`\\b${norm(card.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), ' ');
  const words = rest.split(/\s+/).filter((w) => w && !FILLER.has(w) && !/^[\d.,]+$/.test(w));
  // usa as palavras do texto original (com acento) quando possível
  const origWords = original.split(/\s+/);
  const pretty = words.map((w) => origWords.find((o) => norm(o).replace(/[^\w/]/g, '') === w)?.replace(/[!?.,;:]+$/, '') || w);
  let description = pretty.join(' ').trim().slice(0, 80);
  if (!description || (category && norm(description) === norm(category))) description = category || (type === 'entrada' ? 'Entrada' : 'Gasto');
  description = description.split(' ').map((w, i) => (w.length <= 2 && /^[a-z]+$/i.test(w) && i === 0 && pretty.length === 1 ? w.toUpperCase() : w)).join(' ');
  description = description[0].toUpperCase() + description.slice(1);

  return { type, amount: amount.v, method, card_id: card?.id || null, card_name: card?.name || null, installments,
    category, description, date: findDate(t, now) };
}

// Comandos que não são lançamento
export function parseCommand(text) {
  const t = norm(text).replace(/^\//, '');
  let m = t.match(/^(?:start|conectar|vincular|codigo)\s*[: ]?\s*(\d{6})\b/);
  if (m) return { cmd: 'link', code: m[1] };
  if (/^\d{6}$/.test(t)) return { cmd: 'link', code: t };
  if (/^(start|oi|ola|ajuda|help|menu|comandos|\?)\b/.test(t)) return { cmd: 'help' };
  if (/^(resumo|saldo|extrato|quanto gastei|como estou|como estamos|balanco)\b/.test(t)) return { cmd: 'summary' };
  if (/^(desfazer|desfaz|apagar|apaga|cancelar|cancela|errei|ultimo errado)\b/.test(t)) return { cmd: 'undo' };
  if (/^(contas|vencimentos|o que vence|a pagar)\b/.test(t)) return { cmd: 'bills' };
  if (/^(desconectar|sair|parar|stop)\b/.test(t)) return { cmd: 'unlink' };
  return null;
}

export const CATEGORIES = { saida: DEFAULT_SAIDA, entrada: DEFAULT_ENTRADA };
