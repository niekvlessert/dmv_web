import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const disks = [
  { id: 'DMV1', label: 'Disk 1', file: 'DMV1/DISKEXEC.BAS' },
  { id: 'DMV2', label: 'Disk 2', file: 'DMV2/DISKEXEC.BAS' },
  { id: 'DMV3', label: 'Disk 3', file: 'DMV3/DISKEXEC.BAS' },
  { id: 'DMVFT', label: 'Future Disk', file: 'DMVFT/DISKEXEC.BAS' }
];

function extractDiskTracks(file) {
  const output = execFileSync('strings', ['-n', '4', file], { encoding: 'utf8' });
  const lines = output.split(/\r?\n/);
  const tracks = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('"')) continue;

    const match = line.match(/^"([^"]+)","([^"]+)","([^"]+)","([^"]+)",(\d+)$/);
    if (!match) continue;

    const [, title, mwk, mwm, author, groupRaw] = match;
    tracks.push({
      title,
      author,
      mwm,
      mwk,
      group: Number.parseInt(groupRaw, 10),
      available: true
    });
  }

  return tracks;
}

function short83(filename) {
  const [baseRaw, extRaw = ''] = filename.toUpperCase().split('.');
  const base = baseRaw.slice(0, 8);
  const ext = extRaw.slice(0, 3);
  return ext ? `${base}.${ext}` : base;
}

function fileExistsWith83Fallback(folder, filename) {
  if (filename === '*') return true;
  return (
    existsSync(path.join(folder, filename)) ||
    existsSync(path.join(folder, short83(filename)))
  );
}

const catalog = {
  source: 'DISKEXEC.BAS strings extraction',
  generatedAt: new Date().toISOString(),
  disks: disks.map((disk) => {
    const tracks = extractDiskTracks(disk.file).map((track) => {
      const mwmOk = fileExistsWith83Fallback(disk.id, track.mwm);
      const mwkOk = fileExistsWith83Fallback(disk.id, track.mwk);
      return { ...track, available: mwmOk && mwkOk };
    });

    return {
      id: disk.id,
      label: disk.label,
      folder: disk.id,
      tracks
    };
  })
};

const outPath = path.join('web', 'catalog.json');
writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
console.log(`Wrote ${outPath}`);
