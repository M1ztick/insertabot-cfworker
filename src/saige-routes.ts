/**
 * SAIGE API Routes for Insertabot Worker
 *
 * Mounts on /saige/* endpoints. Dataset is stored in R2 as a CSV
 * under the key specified by the SAIGE_R2_DATASET env var.
 */

import {
  buildSuttaLookup,
  createSaigeRecordTemplate,
  getDatasetStats,
  validateSaigeRecord,
} from "./saige";
import type { Env } from "./worker-configuration";

// ─── CSV helpers ────────────────────────────────────────────────────────────

function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { field += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

function parseCsv(text: string): Array<Record<string, unknown>> {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = parseCsvRow(lines[0]);
  return lines.slice(1).map(line => {
    const values = parseCsvRow(line);
    const record: Record<string, unknown> = {};
    headers.forEach((h, i) => {
      const val = values[i] ?? '';
      if (val.startsWith('[') || val.startsWith('{')) {
        try { record[h] = JSON.parse(val); return; } catch { /* fall through */ }
      }
      record[h] = val;
    });
    return record;
  });
}

async function readDataset(env: Env): Promise<Array<Record<string, unknown>> | null> {
  const key = env.SAIGE_R2_DATASET ?? 'saige_dataset_final.csv';
  const object = await env.SAIGE_TRAINING_DATA.get(key);
  if (!object) return null;
  return parseCsv(await object.text());
}

// ─── Route handler ───────────────────────────────────────────────────────────

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

export async function handleSaigeRequest(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response> {
  try {
    // GET /saige/sutta-lookup?q=<query>
    if (pathname === "/saige/sutta-lookup" && request.method === "GET") {
      const q = new URL(request.url).searchParams.get("q");
      if (!q) return json({ error: "Missing query parameter 'q'" }, 400);
      return json(await buildSuttaLookup(q));
    }

    // GET /saige/generate-record?canonical_id=MN+58&title=...&path_factor=...
    if (pathname === "/saige/generate-record" && request.method === "GET") {
      const url = new URL(request.url);
      const canonicalId = url.searchParams.get("canonical_id");
      const title = url.searchParams.get("title");
      const pathFactor = url.searchParams.get("path_factor") ?? "right_speech";
      const translator = url.searchParams.get("translator") ?? "";
      const tags = url.searchParams.get("tags")?.split(",") ?? [];

      if (!canonicalId || !title) {
        return json({ error: "Missing required parameters: canonical_id, title" }, 400);
      }

      const collMatch = canonicalId.match(/^([A-Za-z]+)/);
      const collection = collMatch ? collMatch[1].toUpperCase() : "MN";

      const record = createSaigeRecordTemplate(
        canonicalId,
        title,
        collection,
        pathFactor,
        `https://suttacentral.net/${canonicalId.toLowerCase().replace(/\s/g, "")}`,
        { translator, themeTags: tags }
      );

      return json(record);
    }

    // POST /saige/validate
    if (pathname === "/saige/validate" && request.method === "POST") {
      const record = await request.json() as Record<string, unknown>;
      return json(validateSaigeRecord(record));
    }

    // GET /saige/stats — reads live data from R2
    if (pathname === "/saige/stats" && request.method === "GET") {
      const records = await readDataset(env);
      if (!records) {
        return json({
          error: "Dataset not found",
          key: env.SAIGE_R2_DATASET ?? 'saige_dataset_final.csv',
          bucket: "SAIGE_TRAINING_DATA",
        }, 404);
      }
      return json(getDatasetStats(records));
    }

    // GET /saige/export?path_factor=right_speech
    if (pathname === "/saige/export" && request.method === "GET") {
      const pathFactor = new URL(request.url).searchParams.get("path_factor");
      const records = await readDataset(env);
      if (!records) {
        return json({
          error: "Dataset not found",
          key: env.SAIGE_R2_DATASET ?? 'saige_dataset_final.csv',
        }, 404);
      }
      const filtered = pathFactor
        ? records.filter(r => r.path_factor === pathFactor)
        : records;
      return json(filtered);
    }

    // GET /saige/conversations?date=YYYY-MM-DD&limit=50
    if (pathname === "/saige/conversations" && request.method === "GET") {
      const url = new URL(request.url);
      const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
      const prefix = `conversations/${date}/`;
      const listed = await env.SAIGE_TRAINING_DATA.list({ prefix, limit });
      const records = await Promise.all(
        listed.objects.map(async (obj) => {
          const raw = await env.SAIGE_TRAINING_DATA.get(obj.key);
          if (!raw) return null;
          try { return await raw.json(); } catch { return null; }
        })
      );
      return json({
        date,
        count: records.filter(Boolean).length,
        truncated: listed.truncated,
        records: records.filter(Boolean),
      });
    }

    // GET /saige — info
    if (pathname === "/saige" && request.method === "GET") {
      return json({
        name: "SAIGE API",
        description: "Sutta-based AI Governance & Ethics toolkit",
        dataset: {
          bucket: "SAIGE_TRAINING_DATA",
          key: env.SAIGE_R2_DATASET ?? 'saige_dataset_final.csv',
        },
        endpoints: [
          { path: "/saige/sutta-lookup?q=<query>", method: "GET", description: "Search suttas by topic" },
          { path: "/saige/generate-record", method: "GET", description: "Generate pre-filled record template" },
          { path: "/saige/validate", method: "POST", description: "Validate record JSON" },
          { path: "/saige/stats", method: "GET", description: "Get dataset statistics from R2" },
          { path: "/saige/export?path_factor=<factor>", method: "GET", description: "Export records from R2 as JSON" },
          { path: "/saige/conversations?date=YYYY-MM-DD&limit=50", method: "GET", description: "Browse scored conversation turns" },
        ],
      });
    }

    return json({ error: "SAIGE endpoint not found" }, 404);
  } catch (error) {
    console.error("SAIGE endpoint error:", error);
    return json({ error: "Internal server error" }, 500);
  }
}
