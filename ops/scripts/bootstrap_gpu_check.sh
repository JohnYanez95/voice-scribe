#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

echo "=== Voice Scribe GPU Check ==="
echo ""

errors=0

# Check 1: nvidia-smi on host
echo "Checking nvidia-smi on host..."
if command -v nvidia-smi &>/dev/null; then
    if nvidia-smi &>/dev/null; then
        pass "nvidia-smi is available and working"
        nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>/dev/null || true
    else
        fail "nvidia-smi found but returned an error"
        errors=$((errors + 1))
    fi
else
    fail "nvidia-smi not found — NVIDIA drivers may not be installed"
    errors=$((errors + 1))
fi

echo ""

# Check 2: GPU visible inside Docker container
echo "Checking GPU inside Docker container..."
if docker run --rm --gpus all nvidia/cuda:12.6.3-runtime-ubuntu24.04 nvidia-smi &>/dev/null; then
    pass "GPU is visible inside Docker container"
else
    fail "GPU is NOT visible inside Docker container"
    warn "Check: Docker Desktop GPU support enabled? WSL2 backend active? NVIDIA Container Toolkit installed?"
    errors=$((errors + 1))
fi

echo ""

if [ "$errors" -eq 0 ]; then
    echo -e "${GREEN}All checks passed. Ready to run Voice Scribe with GPU.${NC}"
    exit 0
else
    echo -e "${RED}${errors} check(s) failed. Fix the issues above before proceeding.${NC}"
    echo ""
    echo "Troubleshooting:"
    echo "  1. Ensure NVIDIA drivers are installed in Windows"
    echo "  2. Ensure Docker Desktop uses the WSL 2 backend"
    echo "  3. Ensure GPU support is enabled in Docker Desktop settings"
    echo "  4. Try: wsl --update && wsl --shutdown, then restart Docker Desktop"
    exit 1
fi
