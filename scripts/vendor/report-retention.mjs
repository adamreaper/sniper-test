import fs from 'node:fs/promises';
import path from 'node:path';

export async function pruneDatedReports({ dir, prefix, extensions = ['.md'], retentionDays = 90, now = new Date() }) {
  if (!dir || !prefix) return [];

  const cutoffMs = now.getTime() - (retentionDays * 24 * 60 * 60 * 1000);
  const removed = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name);
    if (!extensions.includes(ext)) continue;
    if (!entry.name.startsWith(prefix)) continue;

    const stamp = entry.name.slice(prefix.length, entry.name.length - ext.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(stamp)) continue;

    const fileDate = new Date(`${stamp}T00:00:00.000Z`);
    if (Number.isNaN(fileDate.getTime()) || fileDate.getTime() >= cutoffMs) continue;

    for (const candidateExt of extensions) {
      const candidatePath = path.join(dir, `${prefix}${stamp}${candidateExt}`);
      await fs.rm(candidatePath, { force: true }).catch(() => {});
      removed.push(candidatePath);
    }
  }

  return removed;
}
