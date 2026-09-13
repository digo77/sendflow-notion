/**
 * Estado persistente da otimização de tráfego: log de decisões, contadores diários,
 * última escala por objeto, último relatório. Arquivo: data/trafego-state.json.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const STATE_PATH = join(DATA_DIR, 'trafego-state.json');

let cache = null;
let fila = Promise.resolve();

function vazio() {
  return { log: [], pausas: {}, escalas: {}, ultimo_ciclo: null, ultimo_relatorio: null, ultimo_cerebro: null, pausado_geral: false };
}

async function ler() {
  if (cache) return cache;
  try { cache = { ...vazio(), ...JSON.parse(await readFile(STATE_PATH, 'utf-8')) }; } catch { cache = vazio(); }
  return cache;
}

async function salvar(st) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(st, null, 2), 'utf-8');
  cache = st;
}

function comLock(fn) {
  const p = fila.then(fn, fn);
  fila = p.catch(() => {});
  return p;
}

const hojeISO = () => new Date().toISOString().slice(0, 10);

/** Registra uma decisão/ação no log (mantém as últimas 2000). */
export async function registrar(entrada) {
  return comLock(async () => {
    const st = await ler();
    st.log.push({ em: new Date().toISOString(), ...entrada });
    if (st.log.length > 2000) st.log = st.log.slice(-2000);
    await salvar(st);
  });
}

export async function contarPausaHoje(contaId) {
  return comLock(async () => {
    const st = await ler();
    const k = `${contaId}:${hojeISO()}`;
    st.pausas[k] = (st.pausas[k] || 0) + 1;
    await salvar(st);
    return st.pausas[k];
  });
}

export async function pausasHoje(contaId) {
  const st = await ler();
  return st.pausas[`${contaId}:${hojeISO()}`] || 0;
}

export async function marcarEscala(objetoId) {
  return comLock(async () => {
    const st = await ler();
    st.escalas[objetoId] = new Date().toISOString();
    await salvar(st);
  });
}

export async function ultimaEscala(objetoId) {
  const st = await ler();
  return st.escalas[objetoId] || null;
}

export async function salvarCiclo({ relatorio, cerebro }) {
  return comLock(async () => {
    const st = await ler();
    st.ultimo_ciclo = new Date().toISOString();
    if (relatorio !== undefined) st.ultimo_relatorio = relatorio;
    if (cerebro !== undefined) st.ultimo_cerebro = cerebro;
    await salvar(st);
  });
}

export async function setPausaGeral(valor) {
  return comLock(async () => {
    const st = await ler();
    st.pausado_geral = !!valor;
    await salvar(st);
    return st.pausado_geral;
  });
}

export async function lerEstado() {
  const st = await ler();
  return {
    ultimo_ciclo: st.ultimo_ciclo,
    pausado_geral: st.pausado_geral,
    ultimo_relatorio: st.ultimo_relatorio,
    ultimo_cerebro: st.ultimo_cerebro,
    log: st.log.slice(-200).reverse(),
  };
}

export async function historicoRecente(n = 20) {
  const st = await ler();
  return st.log.slice(-n);
}
