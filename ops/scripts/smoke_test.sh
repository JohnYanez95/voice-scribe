#!/usr/bin/env bash
# CPU smoke test (v1 close-out, 2026-04-03):
#   Hardware: Intel i9-12900K (16C/24T, 3200 MHz) / NVIDIA RTX 3090 (24 GB VRAM)
#   DEVICE=cpu WHISPER_MODEL=small — PASS, transcript returned
#   CPU latency:  ~1.87s (small model, no GPU warmup benefit)
#   GPU latency:  ~0.47s warm / ~1.23s cold (large-v3, CUDA float16)
#   GPU is ~4x faster on warm calls with a larger model.
#   Test audio: ops/scripts/test.mp3 (2.46s, "I stayed at home all day yesterday.")
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

API_URL="${API_URL:-http://localhost:8084}"
AUDIO_FILE="${1:-}"

pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }

echo "=== Voice Scribe Smoke Test ==="
echo "API: ${API_URL}"
echo ""

# Test 1: Health endpoint
echo "Testing GET /health..."
HEALTH=$(curl -s -w "\n%{http_code}" "${API_URL}/health")
HTTP_CODE=$(echo "$HEALTH" | tail -1)
BODY=$(echo "$HEALTH" | head -n -1)

if [ "$HTTP_CODE" != "200" ]; then
    fail "/health returned HTTP ${HTTP_CODE}"
fi

if echo "$BODY" | grep -q '"model_loaded":true'; then
    pass "/health returns 200 with model_loaded: true"
else
    fail "/health returned 200 but model_loaded is not true: ${BODY}"
fi

# Test 2: Transcribe endpoint (optional — requires audio file)
if [ -n "$AUDIO_FILE" ]; then
    if [ ! -f "$AUDIO_FILE" ]; then
        fail "Audio file not found: ${AUDIO_FILE}"
    fi

    # Map extension to MIME type for curl
    case "${AUDIO_FILE##*.}" in
        webm) MIME="audio/webm" ;;
        ogg)  MIME="audio/ogg" ;;
        wav)  MIME="audio/wav" ;;
        mp4)  MIME="audio/mp4" ;;
        mp3)  MIME="audio/mpeg" ;;
        *)    MIME="application/octet-stream" ;;
    esac

    echo ""
    echo "Testing POST /transcribe with ${AUDIO_FILE} (${MIME})..."
    TRANSCRIBE=$(curl -s -w "\n%{http_code}" \
        -F "file=@${AUDIO_FILE};type=${MIME}" \
        "${API_URL}/transcribe")
    HTTP_CODE=$(echo "$TRANSCRIBE" | tail -1)
    BODY=$(echo "$TRANSCRIBE" | head -n -1)

    if [ "$HTTP_CODE" != "200" ]; then
        fail "/transcribe returned HTTP ${HTTP_CODE}: ${BODY}"
    fi

    if echo "$BODY" | grep -q '"cleaned"'; then
        pass "/transcribe returns 200 with cleaned transcript"
    else
        fail "/transcribe returned 200 but no cleaned field: ${BODY}"
    fi
else
    echo ""
    echo "(Skipping /transcribe test — no audio file provided)"
    echo "  Usage: $0 <path-to-audio-file>"
fi

# Test 3: Model list endpoint
echo ""
echo "Testing GET /models..."
MODELS=$(curl -s -w "\n%{http_code}" "${API_URL}/models")
HTTP_CODE=$(echo "$MODELS" | tail -1)
BODY=$(echo "$MODELS" | head -n -1)

if [ "$HTTP_CODE" != "200" ]; then
    fail "/models returned HTTP ${HTTP_CODE}"
fi

if echo "$BODY" | grep -q '"current_model"'; then
    pass "/models returns 200 with current_model"
else
    fail "/models returned 200 but no current_model field: ${BODY}"
fi

# Capture startup model for swap-back
STARTUP_MODEL=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['current_model'])")

# Test 4: Model swap endpoint (swap to small, then back)
echo ""
echo "Testing POST /models/swap..."
SWAP=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -d '{"model_name":"small"}' \
    "${API_URL}/models/swap")
HTTP_CODE=$(echo "$SWAP" | tail -1)
BODY=$(echo "$SWAP" | head -n -1)

if [ "$HTTP_CODE" != "200" ]; then
    fail "/models/swap returned HTTP ${HTTP_CODE}: ${BODY}"
fi

if echo "$BODY" | grep -q '"current_model":"small"'; then
    pass "/models/swap to small succeeded"
else
    fail "/models/swap did not set current_model to small: ${BODY}"
fi

# Swap back to startup model
echo "Swapping back to ${STARTUP_MODEL}..."
SWAP_BACK=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -d "{\"model_name\":\"${STARTUP_MODEL}\"}" \
    "${API_URL}/models/swap")
HTTP_CODE=$(echo "$SWAP_BACK" | tail -1)

if [ "$HTTP_CODE" != "200" ]; then
    fail "/models/swap back to ${STARTUP_MODEL} returned HTTP ${HTTP_CODE}"
fi

pass "/models/swap back to ${STARTUP_MODEL} succeeded"

echo ""
echo -e "${GREEN}Smoke test passed.${NC}"
