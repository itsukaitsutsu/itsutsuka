export type Level = 'N1' | 'N2' | 'N3' | 'N4' | 'N5';
// Custom is a personal drawer label, never a JLPT/ranked tier.
export type WordLevel = Level | 'Custom';
export const WORD_LEVELS: WordLevel[] = ['N5', 'N4', 'N3', 'N2', 'N1', 'Custom'];
export type Word<L extends WordLevel = WordLevel> = { id: string; expression: string; reading: string; meaning: string; level: L; tags: string[] };
function parseLine(line: string) {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"' && quoted) { cell += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { cells.push(cell.trim()); cell = ''; }
    else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

export function parseCsv(csv: string, source: string, level: Level): Word<Level>[] {
  return csv.split(/\r?\n/).slice(1).map(parseLine).filter((cells) => cells[0] && cells[1]).map((cells, index) => ({
    id: `${source}-${index}-${cells[0]}`,
    expression: cells[0],
    reading: cells[1],
    meaning: cells[2] || 'meaning not listed',
    level,
    tags: cells[3]?.split(/\s+/).filter(Boolean) ?? [],
  }));
}
