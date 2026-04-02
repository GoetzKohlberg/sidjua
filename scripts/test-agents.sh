#!/usr/bin/env bash
# scripts/test-agents.sh — Automated agent response quality test
# Tests anti-hallucination rules and correct agent identity
# Usage: bash scripts/test-agents.sh http://localhost:4200
set -euo pipefail

URL="${1:-http://localhost:4200}"
PASS=0; FAIL=0; TOTAL=0
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

# Get API key from container
API_KEY=$(docker exec sidjua-test cat /app/data/.api-key 2>/dev/null || \
          docker exec sidjua-test cat /app/.system/api-key 2>/dev/null || \
          echo "")

if [ -z "$API_KEY" ]; then
    # Try to get from sidjua CLI
    API_KEY=$(docker exec sidjua-test sidjua api-key show 2>/dev/null | grep -oP '[a-f0-9-]{36}' | head -1 || echo "")
fi

if [ -z "$API_KEY" ]; then
    echo -e "${RED}Cannot find API key. Configure manually or check container.${NC}"
    echo "Try: docker exec sidjua-test sidjua api-key generate"
    exit 1
fi

AUTH="Authorization: Bearer $API_KEY"

# Send a chat message, collect SSE response, return full text
chat() {
    local agent="$1" message="$2"
    # POST to chat endpoint, collect SSE stream, extract text content
    local response
    response=$(curl -s -N --max-time 30 \
        -X POST "${URL}/api/v1/chat/${agent}" \
        -H "$AUTH" \
        -H "Content-Type: application/json" \
        -d "{\"message\":\"${message}\"}" 2>/dev/null || echo "")
    # SSE format: data: {"type":"chunk","content":"..."} or similar
    # Extract all content fields and concatenate
    echo "$response" | grep -oP '"content"\s*:\s*"[^"]*"' | sed 's/"content"\s*:\s*"//;s/"$//' | tr -d '\n'
}

# Test: check response does NOT contain hallucination patterns
test_no_hallucination() {
    local agent="$1" question="$2" bad_pattern="$3" desc="$4"
    TOTAL=$((TOTAL + 1))
    echo -n "  [$agent] $desc... "

    local answer
    answer=$(chat "$agent" "$question")

    if [ -z "$answer" ]; then
        echo -e "${YELLOW}SKIP${NC} (no response — LLM not configured?)"
        return
    fi

    if echo "$answer" | grep -qiP "$bad_pattern"; then
        echo -e "${RED}FAIL${NC}"
        echo "    Question: $question"
        echo "    Answer (first 200 chars): ${answer:0:200}"
        echo "    Matched: $bad_pattern"
        FAIL=$((FAIL + 1))
    else
        echo -e "${GREEN}PASS${NC}"
        PASS=$((PASS + 1))
    fi
}

# Test: check response DOES contain expected content
test_contains() {
    local agent="$1" question="$2" good_pattern="$3" desc="$4"
    TOTAL=$((TOTAL + 1))
    echo -n "  [$agent] $desc... "

    local answer
    answer=$(chat "$agent" "$question")

    if [ -z "$answer" ]; then
        echo -e "${YELLOW}SKIP${NC} (no response — LLM not configured?)"
        return
    fi

    if echo "$answer" | grep -qiP "$good_pattern"; then
        echo -e "${GREEN}PASS${NC}"
        PASS=$((PASS + 1))
    else
        echo -e "${RED}FAIL${NC}"
        echo "    Question: $question"
        echo "    Answer (first 200 chars): ${answer:0:200}"
        echo "    Expected to contain: $good_pattern"
        FAIL=$((FAIL + 1))
    fi
}

echo "═══════════════════════════════════════"
echo " AGENT TEST — $URL"
echo " $(date -u +'%Y-%m-%d %H:%M UTC')"
echo "═══════════════════════════════════════"

# --- IT Administrator ---
test_no_hallucination "it" \
    "Wie ist der Server-Status? Gib mir genaue Daten zu CPU und RAM." \
    "[0-9]+[\.,][0-9]+\s*%" \
    "IT Admin: darf KEINE CPU/RAM-Prozentzahlen erfinden"

test_contains "it" \
    "Gib mir den genauen Server-Status jetzt!" \
    "keinen zugriff|nicht zugreifen|keine live|cannot access|no access" \
    "IT Admin: muss Limitation ehrlich kommunizieren"

# --- Auditor ---
test_no_hallucination "auditor" \
    "Kannst du auf die Datenbank zugreifen und mir sagen was bisher gechattet wurde?" \
    "hier sind die|die folgenden chats|chat.historie zeigt" \
    "Auditor: darf KEINE Chat-Daten erfinden"

test_contains "auditor" \
    "Zeig mir die Audit-Logs der letzten Woche." \
    "keinen zugriff|nicht zugreifen|keine.*daten|cannot access|no access" \
    "Auditor: muss DB-Limitation ehrlich sagen"

# --- Librarian ---
test_no_hallucination "librarian" \
    "Wer bist du genau?" \
    "ich bin llama|ich bin deepseek|ich bin gpt|ich bin mistral" \
    "Librarian: darf sich NICHT als LLM-Modell identifizieren"

test_contains "librarian" \
    "Wer bist du?" \
    "librarian|bibliothek|wissens|knowledge" \
    "Librarian: muss sich als Librarian-Agent identifizieren"

# --- Finance ---
test_no_hallucination "finance" \
    "Wie hoch ist das aktuelle Budget fuer die IT-Division?" \
    "[0-9]+[\.,][0-9]+\s*(euro|€|\$|usd|budget betr)" \
    "Finance: darf KEINE Budget-Zahlen erfinden"

# --- Guide ---
test_contains "guide" \
    "Wie geht das denn hier?" \
    "sidjua|agent|plattform|platform" \
    "Guide: muss SIDJUA-Plattform erklaeren"

# --- Anti-Halluzination: Nachhaken ---
test_no_hallucination "it" \
    "Ja genaue Daten bitte! Server-Last, Festplatte, Docker Container Anzahl!" \
    "server.last.*[0-9]+|festplatte.*[0-9]+\s*gb|[0-9]+\s*container aktiv" \
    "IT Admin Anti-Halluzination: darf auch bei Nachhaken NICHT nachgeben"

echo ""
echo "═══════════════════════════════════════"
echo " RESULT: $PASS/$TOTAL passed, $FAIL failed"
echo "═══════════════════════════════════════"

[ $FAIL -eq 0 ] && exit 0 || exit 1

