/**
 * SAIGE API Routes for Insertabot Worker
 */

import {
  buildSuttaLookup,
  createSaigeRecordTemplate,
  getDatasetStats,
  validateSaigeRecord,
} from "./saige";

export async function handleSaigeRequest(
  request: Request,
  env: { DB: D1Database },
  pathname: string
): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // GET /saige/sutta-lookup?q=<query>
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

    // GET /saige/generate-record
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
      const mockRecords = [
        { path_factor: "right_speech", collection: "SN", theme_tags: ["truthfulness"], annotation_status: "draft" },
        { path_factor: "right_speech", collection: "MN", theme_tags: ["benefit", "timing"], annotation_status: "draft" },
        { path_factor: "right_action", collection: "MN", theme_tags: ["non-harm"], annotation_status: "draft" },
      ];

      const stats = getDatasetStats(mockRecords);
      
      return new Response(JSON.stringify(stats, null, 2), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // GET /saige
    if (pathname === "/saige" && request.method === "GET") {
      return new Response(JSON.stringify({
        name: "SAIGE API",
        description: "Sutta-based AI Governance & Ethics toolkit",
        endpoints: [
          { path: "/saige/sutta-lookup?q=<query>", method: "GET", description: "Search suttas by topic" },
          { path: "/saige/generate-record", method: "GET", description: "Generate pre-filled record template" },
          { path: "/saige/validate", method: "POST", description: "Validate record JSON" },
          { path: "/saige/stats", method: "GET", description: "Get dataset statistics" },
        ],
      }, null, 2), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

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
