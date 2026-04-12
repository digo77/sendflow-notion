import { readFile, writeFile, readdir, unlink, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_PATH = join(__dirname, 'logs', 'execucoes.json');
const BACKUPS_DIR = join(__dirname, 'backups');
const MAX_BACKUPS = 30;

/**
 * Registra uma entrada no log de execuções.
 */
export function registrarLog(pageId, status, detalhe) {
  const entry = {
    timestamp: new Date().toISOString(),
    pageId,
    status,
    detalhe: String(detalhe).slice(0, 1000),
  };

  // Leitura e escrita síncrona-like via promise chain para evitar race conditions
  readFile(LOGS_PATH, 'utf-8')
    .then((raw) => JSON.parse(raw))
    .catch(() => [])
    .then((logs) => {
      logs.push(entry);
      // Manter apenas os últimos 5000 registros
      if (logs.length > 5000) logs = logs.slice(-5000);
      return writeFile(LOGS_PATH, JSON.stringify(logs, null, 2));
    })
    .catch((err) => console.error('[Log] Erro ao registrar:', err.message));
}

/**
 * Executa backup do arquivo de logs.
 * - Copia logs/execucoes.json para backups/execucoes_YYYY-MM-DD_HH-mm.json
 * - Mantém apenas os últimos 30 backups
 */
export async function runBackup() {
  try {
    if (!existsSync(LOGS_PATH)) {
      console.log('[Backup] Nenhum arquivo de log encontrado, pulando.');
      return;
    }

    const now = new Date();
    const ts = now.toISOString().replace(/T/, '_').replace(/:/g, '-').slice(0, 16);
    const dest = join(BACKUPS_DIR, `execucoes_${ts}.json`);

    await copyFile(LOGS_PATH, dest);
    console.log(`[Backup] Criado: ${dest}`);

    // Limpar backups antigos
    const files = (await readdir(BACKUPS_DIR))
      .filter((f) => f.startsWith('execucoes_') && f.endsWith('.json'))
      .sort();

    if (files.length > MAX_BACKUPS) {
      const toDelete = files.slice(0, files.length - MAX_BACKUPS);
      for (const f of toDelete) {
        await unlink(join(BACKUPS_DIR, f));
        console.log(`[Backup] Removido antigo: ${f}`);
      }
    }

    console.log(`[Backup] Concluído. ${Math.min(files.length, MAX_BACKUPS)} backup(s) mantido(s).`);
  } catch (err) {
    console.error(`[Backup] Falha:`, err.message);
  }
}
