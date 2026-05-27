/**
 * SAIGE R2 Data Service
 * 
 * Fetches and parses SAIGE training data from R2 bucket
 */

const CSV_DELIMITER = ',';
const CSV_QUOTE = '"';

interface CsvParseOptions {
  delimiter?: string;
  quote?: string;
}

/**
 * Simple CSV parser (handles quoted fields, newlines in quotes)
 */
function parseCsv(content: string, options: CsvParseOptions = {}): Array<Record<string, string>> {
  const delimiter = options.delimiter || CSV_DELIMITER;
  const quote = options.quote || CSV_QUOTE;
  
  const lines: string[] = [];
  let currentLine = '';
  let inQuotes = false;
  
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];
    
    if (char === quote) {
      if (inQuotes && nextChar === quote) {
        // Escaped quote
        currentLine += quote;
        i++; // Skip next quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === '\n' && !inQuotes) {
      lines.push(currentLine);
      currentLine = '';
    } else if (char === '\r' && !inQuotes) {
      // Skip carriage return
    } else {
      currentLine += char;
    }
  }
  
  // Don't forget last line
  if (currentLine) {
    lines.push(currentLine);
  }
  
  // Parse header and rows
  if (lines.length === 0) return [];
  
  const headers = parseCsvLine(lines[0], delimiter, quote);
  const rows: Array<Record<string, string>> = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i], delimiter, quote);
    const row: Record<string, string> = {};
    
    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });
    
    rows.push(row);
  }
  
  return rows;
}

function parseCsvLine(line: string, delimiter: string, quote: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const prevChar = line[i - 1];
    
    if (char === quote) {
      // Handle escape quotes ("") - but only if we're in quotes
      if (inQuotes && line[i + 1] === quote) {
        current += quote;
        i++; // Skip next quote
      } else if (!inQuotes && prevChar !== quote) {
        // Start quote
        inQuotes = true;
      } else {
        // End quote
        inQuotes = false;
      }
    } else if (char === delimiter && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  
  fields.push(current.trim());
  return fields;
}

/**
 * Convert CSV row to SAIGE record format
 */
function csvRowToSaigeRecord(row: Record<string, string>): Record<string, unknown> | null {
  // Skip empty rows or header rows
  if (!row.id || row.id === 'id' || !row.canonical_id) {
    return null;
  }
  
  return {
    id: row.id,
    canonical_id: row.canonical_id,
    title: row.title || '',
    collection: row.collection || '',
    path_factor: row.path_factor || '',
    theme_tags: row.theme_tags ? row.theme_tags.split(';').map(t => t.trim()) : [],
    source_tradition: row.source_tradition || 'Pali Canon / Theravada',
    source_platform: row.source_platform || 'Canonical reference',
    source_url: row.source_url || '',
    translator: row.translator || '',
    pali_available: row.pali_available === 'true',
    pali_url: row.pali_url || null,
    source_excerpt: row.source_excerpt || '',
    source_summary: row.source_summary || '',
    core_principle: row.core_principle || '',
    interpretive_note: row.interpretive_note || '',
    ai_behavior_mapping: row.ai_behavior_mapping || '',
    behavior_targets: row.behavior_targets ? row.behavior_targets.split(';').map(t => t.trim()) : [],
    failure_modes: row.failure_modes ? row.failure_modes.split(';').map(t => t.trim()) : [],
    recommended_response_traits: row.recommended_response_traits ? row.recommended_response_traits.split(';').map(t => t.trim()) : [],
    unsafe_misreadings: row.unsafe_misreadings ? row.unsafe_misreadings.split(';').map(t => t.trim()) : [],
    example_use_cases: row.example_use_cases ? row.example_use_cases.split(';').map(t => t.trim()) : [],
    example_prompt_types: row.example_prompt_types ? row.example_prompt_types.split(';').map(t => t.trim()) : [],
    evaluation_questions: row.evaluation_questions ? row.evaluation_questions.split(';').map(t => t.trim()) : [],
    research_notes: row.research_notes || '',
    annotation_author: row.annotation_author || 'Mistyk',
    annotation_status: row.annotation_status || 'draft',
    confidence: row.confidence || 'high',
    version: row.version || '0.1',
    last_updated: row.last_updated || new Date().toISOString().split('T')[0],
  };
}

/**
 * Fetch and parse SAIGE dataset from R2
 */
export async function fetchSaigeDatasetFromR2(
  r2Bucket: R2Bucket,
  filename: string = 'saige_dataset_final.csv'
): Promise<Array<Record<string, unknown>>> {
  try {
    const object = await r2Bucket.get(filename);
    
    if (!object) {
      console.error(`SAIGE dataset not found in R2: ${filename}`);
      return [];
    }
    
    const csvContent = await object.text();
    const rows = parseCsv(csvContent);
    
    return rows
      .map(csvRowToSaigeRecord)
      .filter((r): r is Record<string, unknown> => r !== null);
  } catch (error) {
    console.error('Error fetching SAIGE data from R2:', error);
    return [];
  }
}

/**
 * Get available datasets in R2 bucket
 */
export async function listSaigeDatasets(r2Bucket: R2Bucket): Promise<string[]> {
  try {
    const objects = await r2Bucket.list();
    return objects.objects
      .filter(obj => obj.key.endsWith('.csv') && obj.key.includes('saige'))
      .map(obj => obj.key);
  } catch (error) {
    console.error('Error listing R2 datasets:', error);
    return [];
  }
}

/**
 * Search records by keyword/excerpt content
 */
export function searchRecords(
  records: Array<Record<string, unknown>>,
  query: string
): Array<Record<string, unknown>> {
  const lowerQuery = query.toLowerCase();
  
  return records.filter(record => {
    const searchable = [
      record.title as string,
      record.source_excerpt as string,
      record.source_summary as string,
      record.core_principle as string,
      record.interpretive_note as string,
      record.ai_behavior_mapping as string,
    ].join(' ').toLowerCase();
    
    return searchable.includes(lowerQuery);
  });
}

/**
 * Filter records by path factor
 */
export function filterByPathFactor(
  records: Array<Record<string, unknown>>,
  pathFactor: string
): Array<Record<string, unknown>> {
  return records.filter(r => r.path_factor === pathFactor);
}

/**
 * Get dataset statistics from R2 data
 */
export function calculateDatasetStats(records: Array<Record<string, unknown>>) {
  const pathFactorCounts: Record<string, number> = {};
  const collectionCounts: Record<string, number> = {};
  const statusCounts: Record<string, number> = {};
  const themeCounts: Record<string, number> = {};
  
  let completeRecords = 0;
  
  for (const record of records) {
    // Path factor
    const pf = record.path_factor as string;
    if (pf) pathFactorCounts[pf] = (pathFactorCounts[pf] || 0) + 1;
    
    // Collection
    const coll = record.collection as string;
    if (coll) collectionCounts[coll] = (collectionCounts[coll] || 0) + 1;
    
    // Status
    const status = record.annotation_status as string;
    if (status) statusCounts[status] = (statusCounts[status] || 0) + 1;
    
    // Themes
    const themes = record.theme_tags as string[] || [];
    themes.forEach(theme => {
      themeCounts[theme] = (themeCounts[theme] || 0) + 1;
    });
    
    // Completeness check
    const hasCore = (record.core_principle as string)?.length > 20;
    const hasInterpretation = (record.interpretive_note as string)?.length > 50;
    const hasMapping = (record.ai_behavior_mapping as string)?.length > 50;
    
    if (hasCore && hasInterpretation && hasMapping) {
      completeRecords++;
    }
  }
  
  const topThemes = Object.entries(themeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag, count]) => ({ tag, count }));
  
  const eightfoldPathCoverage = Math.round(
    (Object.keys(pathFactorCounts).length / 8) * 100
  );
  
  return {
    total: records.length,
    complete: completeRecords,
    byPathFactor: pathFactorCounts,
    byCollection: collectionCounts,
    byStatus: statusCounts,
    topThemes,
    coverage: {
      eightfoldPath: eightfoldPathCoverage,
      completeness: Math.round((completeRecords / records.length) * 100) || 0,
    },
  };
}