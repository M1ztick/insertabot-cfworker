/**
 * SAIGE API Routes for Insertabot Worker
 * 
 * Mounts on /saige/* endpoints
 */

import {
  buildSuttaLookup,
  createSaigeRecordTemplate,
  validateSaigeRecord,
} from "./saige";
import {
  fetchSaigeDatasetFromR2,
  listSaigeDatasets,
  searchRecords,
  filterByPathFactor,
  calculateDatasetStats,
} from "./lib/saige-r2";
import type { Env } from "./worker-configuration";

export async function handleSaigeRequest(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // GET /saige/sutta-lookup?q=<query>&collection=<col>&limit=<n>
    if (pathname === "/saige/sutta-lookup" && request.method === "GET") {
      const url = new URL(request.url);
      const query = url.searchParams.get("q");
      
      if (!query) {
        return new Response(
          JSON.stringify({ error: "Missing query parameter 'q'" }),
          { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }

      const results = await buildSuttaLookup(query);
      
      return new Response(JSON.stringify(results), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // GET /saige/generate-record?canonical_id=MN+58&title=...&path_factor=...
    if (pathname === "/saige/generate-record" && request.method === "GET") {
      const url = new URL(request.url);
      const canonicalId = url.searchParams.get("canonical_id");
      const title = url.searchParams.get("title");
      const pathFactor = url.searchParams.get("path_factor") || "right_speech";
      const translator = url.searchParams.get("translator") || "";
      const tags = url.searchParams.get("tags")?.split(",") || [];

      if (!canonicalId || !title) {
        return new Response(
          JSON.stringify({ error: "Missing required parameters: canonical_id, title" }),
          { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }

      // Parse collection from canonical ID
      const collMatch = canonicalId.match(/^([A-Za-z]+)/);
      const collection = collMatch ? collMatch[1].toUpperCase() : "MN";

      const record = createSaigeRecordTemplate(
        canonicalId,
        title,
        collection,
        pathFactor,
        `https://suttacentral.net/${canonicalId.toLowerCase().replace(/\s/g, "")}`,
        {
          id: `saige-${pathFactor.substring(0, 2)}-XXX`,
          translator,
          themeTags: tags,
        }
      );

      return new Response(JSON.stringify(record, null, 2), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // GET /saige/records?q=<query>&path_factor=<pf>
    if (pathname === "/saige/records" && request.method === "GET") {
      const url = new URL(request.url);
      const query = url.searchParams.get("q");
      const pathFactor = url.searchParams.get("path_factor");
      
      let records = await fetchSaigeDatasetFromR2(
        env.SAIGE_TRAINING_DATA,
        env.SAIGE_R2_DATASET || 'saige_dataset_final.csv'
      );
      
      // Filter by path factor if provided
      if (pathFactor) {
        records = filterByPathFactor(records, pathFactor);
      }
      
      // Search if query provided
      if (query) {
        records = searchRecords(records, query);
      }
      
      return new Response(JSON.stringify(records, null, 2), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // POST /saige/validate
    if (pathname === "/saige/validate" && request.method === "POST") {
      const record = await request.json() as Record<string, unknown>;
      const validation = validateSaigeRecord(record);
      
      return new Response(JSON.stringify(validation, null, 2), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // GET /saige/stats
    if (pathname === "/saige/stats" && request.method === "GET") {
      const records = await fetchSaigeDatasetFromR2(
        env.SAIGE_TRAINING_DATA,
        env.SAIGE_R2_DATASET || 'saige_dataset_final.csv'
      );

      const stats = calculateDatasetStats(records);
      
      return new Response(JSON.stringify(stats, null, 2), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // GET /saige/datasets
    if (pathname === "/saige/datasets" && request.method === "GET") {
      const datasets = await listSaigeDatasets(env.SAIGE_TRAINING_DATA);
      
      return new Response(JSON.stringify({
        datasets,
        current: env.SAIGE_R2_DATASET || 'saige_dataset_final.csv'
      }, null, 2), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // GET /saige/export?path_factor=right_speech
    if (pathname === "/saige/export" && request.method === "GET") {
      const url = new URL(request.url);
      const pathFactor = url.searchParams.get("path_factor");
      
      let records = await fetchSaigeDatasetFromR2(
        env.SAIGE_TRAINING_DATA,
        env.SAIGE_R2_DATASET || 'saige_dataset_final.csv'
      );
      
      if (pathFactor) {
        records = filterByPathFactor(records, pathFactor);
      }
      
      return new Response(JSON.stringify(records, null, 2), {
        headers: { 
          "Content-Type": "application/json", 
          "Content-Disposition": `attachment; filename="saige-export-${pathFactor || 'all'}.json"`,
          ...corsHeaders 
        },
      });
    }

    // GET /saige - Info page
    if (pathname === "/saige" && request.method === "GET") {
      return new Response(JSON.stringify({
        name: "SAIGE API",
        description: "Sutta-based AI Governance & Ethics toolkit",
        endpoints: [
          { path: "/saige/sutta-lookup?q=<query>", method: "GET", description: "Search suttas by topic" },
          { path: "/saige/generate-record", method: "GET", description: "Generate pre-filled record template" },
          { path: "/saige/records?q=<query>&path_factor=<pf>", method: "GET", description: "Query SAIGE dataset from R2" },
          { path: "/saige/validate", method: "POST", description: "Validate record JSON" },
          { path: "/saige/stats", method: "GET", description: "Get dataset statistics from R2" },
          { path: "/saige/datasets", method: "GET", description: "List available CSV datasets in R2" },
          { path: "/saige/export?path_factor=<pf>", method: "GET", description: "Export records as JSON" },
        ],
      }, null, 2), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Not found
    return new Response(
      JSON.stringify({ error: "SAIGE endpoint not found" }),
      { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  } catch (error) {
    console.error("SAIGE endpoint error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
}