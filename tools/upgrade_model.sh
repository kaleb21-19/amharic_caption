#!/bin/bash
# Download and convert badrex/Ethio-ASR-multilingual-600M to CTranslate2 int8
set -e

MODEL_NAME="badrex/Ethio-ASR-multilingual-600M"
STAGE_DIR="tools/stage"
MODEL_DIR="$STAGE_DIR/ethio-asr-mu-600m"
OUTPUT_DIR="$STAGE_DIR/model-ct2-int8-mu600"

echo "=== Upgrading to $MODEL_NAME ==="
echo "This will download ~2.4GB and convert to int8 (~600MB)"
echo ""

# Check if huggingface-cli is available
if ! command -v huggingface-cli &> /dev/null; then
    echo "ERROR: huggingface-cli not found"
    echo "Install with: pip install huggingface-hub"
    exit 1
fi

# Create staging directory
mkdir -p "$STAGE_DIR"

# Download the model (resume if interrupted)
echo "Step 1: Downloading model from Hugging Face..."
if [ -d "$MODEL_DIR" ]; then
    echo "Model directory exists, resuming download..."
fi

huggingface-cli download "$MODEL_NAME" \
    --local-dir "$MODEL_DIR" \
    --local-dir-use-symlinks False

# Verify download
MODEL_FILE="$MODEL_DIR/model.safetensors"
if [ -f "$MODEL_FILE" ]; then
    SIZE=$(stat -f%z "$MODEL_FILE" 2>/dev/null || stat -c%s "$MODEL_FILE" 2>/dev/null)
    SIZE_GB=$(echo "scale=2; $SIZE / 1024 / 1024 / 1024" | bc)
    echo "Model file size: ${SIZE_GB} GB"
    
    if [ "$SIZE" -lt 1000000000 ]; then
        echo "WARNING: Model file appears incomplete (< 1GB)"
        echo "Expected ~2.4GB. Deleting and re-downloading..."
        rm -rf "$MODEL_DIR"
        huggingface-cli download "$MODEL_NAME" \
            --local-dir "$MODEL_DIR" \
            --local-dir-use-symlinks False
    fi
else
    echo "ERROR: Model file not found at $MODEL_FILE"
    exit 1
fi

# Install ctranslate2 if needed
echo ""
echo "Step 2: Installing ctranslate2..."
pip install -q ctranslate2

# Convert to CTranslate2 int8
echo ""
echo "Step 3: Converting to CTranslate2 int8..."
echo "This may take 5-10 minutes..."

ct2-transformers-converter \
    --model "$MODEL_DIR" \
    --output_dir "$OUTPUT_DIR" \
    --quantization int8 \
    --copy_files preprocessor_config.json vocab.json

# Create model metadata
echo ""
echo "Step 4: Creating model metadata..."
cat > "$OUTPUT_DIR/model_meta.json" << 'EOF'
{
  "engine": "ctranslate2",
  "compute_type": "int8",
  "blank_id": 408,
  "sample_rate": 16000,
  "source_model": "badrex/Ethio-ASR-multilingual-600M",
  "conversion_date": "2026-09-20"
}
EOF

echo ""
echo "=== Conversion complete! ==="
echo "Model saved to: $OUTPUT_DIR"
echo ""
echo "To test the new model:"
echo "  AMH_MODEL_DIR=$OUTPUT_DIR python3 ethio_srt.py <audio.wav> <output.srt>"
echo ""
echo "To run accuracy tests:"
echo "  AMH_MODEL_DIR=$OUTPUT_DIR bash tools/test/run_engine.sh --fixtures tools/test/fixtures_real --max-wer 0.15"
