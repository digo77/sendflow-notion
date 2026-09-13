import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { veredito, planejarAcoes, sinaisFadiga, derivar, VEREDITO } from './regras.js';

const metas = JSON.parse(readFileSync(new URL('./metas.json', import.meta.url), 'utf-8'));
const perpetuo = { nome: 'Cliente P', tipo: 'perpetuo', ticket_medio: 497 };
const lancamento = { nome: 'Cliente L', tipo: 'lancamento' };

test('lançamento: poucos dias = observar', () => {
  const r = veredito({ id: '1', nome: 'ad', dias: 1, spend: 500, leads: 0, leads_qualificados: 0 }, metas, lancamento);
  assert.equal(r.veredito, VEREDITO.OBSERVAR);
});

test('lançamento: gastou 3x CPL qualificado alvo sem qualificado = matar', () => {
  const r = veredito({ id: '1', nome: 'ad', dias: 4, spend: 18, leads: 6, leads_qualificados: 0 }, metas, lancamento);
  assert.equal(r.veredito, VEREDITO.MATAR);
});

test('lançamento: CPL bom mas quase ninguém qualifica = ajustar', () => {
  const r = veredito({ id: '1', nome: 'ad', dias: 4, spend: 50, leads: 25, leads_qualificados: 4 }, metas, lancamento);
  assert.equal(r.veredito, VEREDITO.AJUSTAR);
  assert.match(r.motivos[0], /curioso/);
});

test('lançamento: CPL barato mas qualidade péssima com volume = matar', () => {
  const r = veredito({ id: '1', nome: 'ad', dias: 4, spend: 60, leads: 25, leads_qualificados: 2 }, metas, lancamento);
  assert.equal(r.veredito, VEREDITO.MATAR);
  assert.ok(r.motivos.some((m) => /curioso/.test(m)));
});

test('lançamento: CPL qualificado dentro do alvo com volume = escalar', () => {
  const r = veredito({ id: '1', nome: 'ad', dias: 4, spend: 60, leads: 25, leads_qualificados: 12, frequencia: 1.5 }, metas, lancamento);
  assert.equal(r.veredito, VEREDITO.ESCALAR);
});

test('perpétuo: ROAS 2.6 com 5 compras = escalar forte', () => {
  const r = veredito({ id: '1', nome: 'ad', dias: 7, spend: 1000, receita: 2600, compras: 5, ctr: 1.4, frequencia: 1.8 }, metas, perpetuo);
  assert.equal(r.veredito, VEREDITO.ESCALAR);
  assert.equal(r.forte, true);
});

test('perpétuo: ROAS 2.1 = escalar (não forte)', () => {
  const r = veredito({ id: '1', nome: 'ad', dias: 7, spend: 1000, receita: 2100, compras: 4, ctr: 1.4 }, metas, perpetuo);
  assert.equal(r.veredito, VEREDITO.ESCALAR);
  assert.equal(r.forte, false);
});

test('perpétuo: ROAS 1.5 com CTR bom = ajustar pós-clique', () => {
  const r = veredito({ id: '1', nome: 'ad', dias: 7, spend: 1000, receita: 1500, compras: 3, ctr: 1.4 }, metas, perpetuo);
  assert.equal(r.veredito, VEREDITO.AJUSTAR);
  assert.ok(r.motivos.some((m) => /pós-clique/.test(m)));
});

test('perpétuo: gastou 3x CPA alvo sem venda = matar', () => {
  // CPA alvo = 497 / 1.8 ≈ 276; 3x ≈ 828
  const r = veredito({ id: '1', nome: 'ad', dias: 5, spend: 900, receita: 0, compras: 0 }, metas, perpetuo);
  assert.equal(r.veredito, VEREDITO.MATAR);
});

test('fadiga: frequência alta e CTR caindo geram sinais', () => {
  const s = sinaisFadiga({ frequencia: 3.4, ctr: 0.7, ctr_anterior: 1.2, cpm: 30, cpm_anterior: 25 }, metas);
  assert.equal(s.length, 2);
});

test('escalar com fadiga vira observar', () => {
  const r = veredito({ id: '1', nome: 'ad', dias: 7, spend: 1000, receita: 2600, compras: 5, ctr: 1.4, frequencia: 3.5 }, metas, perpetuo);
  assert.equal(r.veredito, VEREDITO.OBSERVAR);
  assert.equal(r.fadiga.length, 1);
});

test('lucro estimado desconta taxa e imposto', () => {
  const d = derivar({ spend: 1000, receita: 2000 }, metas);
  // 2000 * (1-0.099) * (1-0.06) - 1000 = 693.88
  assert.ok(Math.abs(d.lucro - 693.88) < 0.01);
});

test('planejar: modo sombra manda tudo para aprovação', () => {
  const vs = [
    { id: 'a', nome: 'ruim', nivel: 'ad', veredito: VEREDITO.MATAR, motivos: ['x'], fadiga: [], spend: 100 },
    { id: 'b', nome: 'bom', nivel: 'adset', veredito: VEREDITO.ESCALAR, forte: true, motivos: ['y'], fadiga: [], budget_diario: 100, spend: 500 },
  ];
  const p = planejarAcoes(vs, metas);
  assert.equal(p.autonomas.length, 0);
  assert.equal(p.aprovacao.length, 2);
  const esc = p.aprovacao.find((a) => a.tipo === 'escalar');
  assert.equal(esc.parametros.novo_budget, 150);
  assert.equal(esc.parametros.duplicar, true);
});

test('planejar: fora do modo sombra, pausa de ad sem resultado é autônoma até o teto diário', () => {
  const m = JSON.parse(JSON.stringify(metas));
  m.guardrails.modo_sombra = false;
  const vs = ['a', 'b', 'c', 'd'].map((id) => ({ id, nome: id, nivel: 'ad', veredito: VEREDITO.MATAR, motivos: ['x'], fadiga: [], spend: 50 }));
  const p = planejarAcoes(vs, m, { pausas_hoje: 1 });
  assert.equal(p.autonomas.length, 2);
  assert.equal(p.aprovacao.length, 2);
});

test('planejar: nunca mexe em aprendizado', () => {
  const vs = [{ id: 'a', nome: 'a', nivel: 'adset', veredito: VEREDITO.ESCALAR, motivos: ['y'], fadiga: [], em_aprendizado: true, budget_diario: 100 }];
  const p = planejarAcoes(vs, metas);
  assert.equal(p.aprovacao.length, 0);
  assert.equal(p.alertas.length, 1);
});

test('planejar: respeita intervalo mínimo entre escalas', () => {
  const vs = [{ id: 'a', nome: 'a', nivel: 'adset', veredito: VEREDITO.ESCALAR, motivos: ['y'], fadiga: [], budget_diario: 100, ultima_escala_em: '2026-09-12T00:00:00Z' }];
  const p = planejarAcoes(vs, metas, { agora: '2026-09-12T20:00:00Z' });
  assert.equal(p.aprovacao.length, 0);
  assert.equal(p.alertas.length, 1);
});
