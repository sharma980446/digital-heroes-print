import { parse } from 'csv-parse/sync';
import { PrintError } from '@/domain/catalogue';
import type { Runner } from '@/domain/design';

export const maxCsvBytes = 256 * 1024;

export function readCsv(source: string) {
  if (Buffer.byteLength(source) > maxCsvBytes) throw new PrintError('Upload a CSV smaller than 256 KB.');
  let records: string[][];
  try {
    records = parse(source, { bom: true, skip_empty_lines: true, max_record_size: 8192, to: 1002 });
  } catch {
    throw new PrintError('Use a UTF-8 CSV with a header and the same number of fields on each row.');
  }
  const [header, ...rows] = records;
  const headers = header?.map((cell) => cell.trim()) ?? [];
  if (headers.length < 2 || headers.length > 30 || headers.some((cell) => !cell) ||
      new Set(headers).size !== headers.length || headers.some((cell) => cell.length > 80)) {
    throw new PrintError('Use 2–30 unique, non-empty column names.');
  }
  if (!rows.length || rows.length > 1000) throw new PrintError('Include 1–1,000 data rows.');
  return { headers, rows };
}

export function mapRunners(csv: ReturnType<typeof readCsv>, mapping: { name: string; number: string }, expected: number) {
  const { headers, rows } = csv;
  if (rows.length !== expected) {
    throw new PrintError(`This order has ${expected} units. The CSV has ${rows.length} rows. Match the quantity or correct the CSV.`);
  }
  const nameColumn = headers.indexOf(mapping.name);
  const numberColumn = headers.indexOf(mapping.number);
  if (nameColumn < 0 || numberColumn < 0 || nameColumn === numberColumn) {
    throw new PrintError('Map the name and bib number to two different columns.');
  }
  const seen = new Set<string>();
  return rows.map((row, index): Runner => {
    const name = row[nameColumn].normalize('NFC').trim();
    const number = row[numberColumn].normalize('NFC').trim();
    if (!name || name.length > 120 || /\p{C}/u.test(name)) {
      throw new PrintError(`Row ${index + 1}, name. Use 1–120 printable characters.`);
    }
    if (!/^[0-9]{1,8}$/.test(number)) throw new PrintError(`Row ${index + 1}, bib number. Use 1–8 digits.`);
    const uniqueNumber = number.replace(/^0+(?=\d)/, '');
    if (seen.has(uniqueNumber)) throw new PrintError(`Row ${index + 1}, bib number. ${number} duplicates an earlier bib.`);
    seen.add(uniqueNumber);
    return { name, number };
  });
}
