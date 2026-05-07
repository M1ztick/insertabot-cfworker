#!/bin/bash

# Test script for InsertaBot Workers AI + MCP implementation
# Usage: ./test.sh [base-url]
# Example: ./test.sh http://localhost:8787

BASE_URL="${1:-http://localhost:8787}"

echo "🧪 Testing InsertaBot Workers AI + MCP Implementation"
echo "Base URL: $BASE_URL"
echo ""

# Test 1: Health check
echo "1️⃣  Testing health endpoint..."
curl -s "$BASE_URL/health" | jq '.'
echo ""

# Test 2: Non-streaming chat
echo "2️⃣  Testing non-streaming chat..."
curl -s -X POST "$BASE_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "@cf/moonshotai/kimi-k2.6",
    "messages": [
      {"role": "user", "content": "Say hello in exactly 5 words"}
    ],
    "stream": false,
    "temperature": 0.7
  }' | jq '.'
echo ""

# Test 3: Streaming chat
echo "3️⃣  Testing streaming chat..."
echo "Streaming response (first 10 lines):"
curl -s -X POST "$BASE_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "@cf/moonshotai/kimi-k2.6",
    "messages": [
      {"role": "user", "content": "Count from 1 to 5"}
    ],
    "stream": true
  }' | head -n 10
echo ""

# Test 4: MCP Tool - Web Search
echo "4️⃣  Testing MCP tool calling (Tavily search)..."
echo "Asking AI to search the web:"
curl -s -X POST "$BASE_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "@cf/moonshotai/kimi-k2.6",
    "messages": [
      {"role": "user", "content": "Search the web for the latest news about Cloudflare Workers and give me a brief summary"}
    ],
    "stream": false
  }' | jq '.choices[0].message.content'
echo ""

# Test 5: MCP Tool - GitHub
echo "5️⃣  Testing GitHub tool..."
echo "Asking AI about a GitHub repo:"
curl -s -X POST "$BASE_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "@cf/moonshotai/kimi-k2.6",
    "messages": [
      {"role": "user", "content": "Tell me about the cloudflare/workers-sdk GitHub repository"}
    ],
    "stream": false
  }' | jq '.choices[0].message.content'
echo ""

# Test 6: Conversation with Durable Object
echo "6️⃣  Testing conversation persistence..."
CONV_ID="test-$(date +%s)"
echo "Conversation ID: $CONV_ID"

echo "First message:"
curl -s -X POST "$BASE_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"@cf/moonshotai/kimi-k2.6\",
    \"messages\": [
      {\"role\": \"user\", \"content\": \"Remember this number: 42\"}
    ],
    \"conversationId\": \"$CONV_ID\",
    \"stream\": false
  }" | jq '.choices[0].message.content'

echo ""
echo "Second message (should remember 42):"
curl -s -X POST "$BASE_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"@cf/moonshotai/kimi-k2.6\",
    \"messages\": [
      {\"role\": \"user\", \"content\": \"What number did I just tell you?\"}
    ],
    \"conversationId\": \"$CONV_ID\",
    \"stream\": false
  }" | jq '.choices[0].message.content'

echo ""
echo "✅ Tests complete!"
echo ""
echo "📝 Notes:"
echo "  - Tool calling requires TAVILY_API_KEY and GITHUB_TOKEN secrets"
echo "  - If tool tests fail, check: wrangler secret list"
echo "  - View logs: wrangler tail"
