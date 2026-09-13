import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pontuarPesquisa, scoreFinal, normalizarTelefone } from './leads.js';

const metas = JSON.parse(readFileSync(new URL('./metas.json', import.meta.url), 'utf-8'));

test('telefone: adiciona 55 quando vem sem DDI', () => {
  assert.equal(normalizarTelefone('(11) 98765-4321'), '5511987654321');
  assert.equal(normalizarTelefone('+55 11 98765-4321'), '5511987654321');
});

test('pesquisa: lead forte pontua alto', () => {
  const p = pontuarPesquisa({ renda: 'Acima de 10 mil', momento: 'Já vendo e quero escalar', urgencia: 'Agora', investimento: 'Acima de 500' }, metas.pesquisa);
  assert.equal(p.score, 100);
  assert.equal(p.desconhecidas.length, 0);
});

test('pesquisa: curioso pontua baixo', () => {
  const p = pontuarPesquisa({ renda: 'até 2 mil', momento: 'só curiosidade', urgencia: 'sem pressa', investimento: 'não investiria' }, metas.pesquisa);
  assert.ok(p.score < 10);
});

test('pesquisa: aceita acento e caixa diferente, match parcial', () => {
  const p = pontuarPesquisa({ momento: 'JÁ FAÇO E QUERO CRESCER', renda: '5 a 10 mil' }, metas.pesquisa);
  assert.ok(p.score >= 85);
});

test('pesquisa: resposta desconhecida vale 0 e é registrada', () => {
  const p = pontuarPesquisa({ renda: 'prefiro não dizer' }, metas.pesquisa);
  assert.equal(p.score, 0);
  assert.equal(p.desconhecidas.length, 1);
});

test('pesquisa: sem respostas = sem score', () => {
  const p = pontuarPesquisa({}, metas.pesquisa);
  assert.equal(p.score, null);
  assert.equal(p.respondidas, false);
});

test('score final soma bônus de comportamento e penaliza saída do grupo', () => {
  const base = { score_pesquisa: 50, eventos: { entrou_no_grupo: 'x', compareceu_aula: 'x' } };
  assert.equal(scoreFinal(base, metas.pesquisa), 85);
  const saiu = { score_pesquisa: 50, eventos: { entrou_no_grupo: 'x', saiu_do_grupo: 'x' } };
  assert.equal(scoreFinal(saiu, metas.pesquisa), 20);
});
