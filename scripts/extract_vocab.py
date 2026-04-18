import struct
import os

def extract_vocabulary(model_name="Qwen/Qwen2.5-Coder-1.5B"):
    try:
        from transformers import AutoTokenizer
        print(f"Downloading/loading tokenizer for {model_name}...")
        tokenizer = AutoTokenizer.from_pretrained(model_name)
        vocab = tokenizer.get_vocab()
        
        # We need mapping: ID (int) -> bytes
        id_to_bytes = {}
        # Safely convert tokens to standard utf-8 bytes
        for raw_token, t_id in vocab.items():
            # For BPE tokenizers, we try to use the tokenizer's decode to get native presentation
            # If that fails, we fallback to raw string encode
            try:
                # tokenizer.convert_tokens_to_string resolves byte-level 'Ġ' to spaces
                txt = tokenizer.convert_tokens_to_string([raw_token])
                b = txt.encode("utf-8")
            except Exception:
                b = raw_token.encode("utf-8")
            id_to_bytes[t_id] = b

        return id_to_bytes
    except Exception as e:
        print(f"Error loading tokenizer {model_name}: {e}")
        print("Creating a mock vocabulary for demonstration...")
        return {i: f"token_{i}".encode("utf-8") for i in range(1000)}

if __name__ == "__main__":
    vocab = extract_vocabulary()
    
    max_token_id = max(vocab.keys())
    print(f"Max token ID: {max_token_id}")

    # Build binary format
    # Header: Magic "LRPC" (4 bytes), max_token_id (4 bytes)
    header = struct.pack("<4sI", b"LRPC", max_token_id)

    # Offsets and Strings
    offsets = []
    string_blocks = []
    current_offset = 0

    for i in range(max_token_id + 1):
        offsets.append(current_offset)
        b = vocab.get(i, b"")
        string_blocks.append(b)
        current_offset += len(b)
    
    # Append the very final offset so length can be derived for the last token
    offsets.append(current_offset)

    # Pack offsets into little-endian Uint32
    # fmt = "<" + "I" * len(offsets)
    # offset_bytes = struct.pack(fmt, *offsets)
    # Actually, iterative packing or array block is faster:
    import array
    offset_array = array.array("I", offsets)
    # ensure little endian
    if offset_array.itemsize == 4:
        # byte swap if sys is big endian (rare)
        import sys
        if sys.byteorder == 'big':
            offset_array.byteswap()
    offset_bytes = offset_array.tobytes()

    string_bytes = b"".join(string_blocks)

    # Store in frontend public folder for direct fetch by client
    target_dir = os.path.join(os.path.dirname(__file__), "..", "frontend", "public")
    os.makedirs(target_dir, exist_ok=True)
    
    output_path = os.path.join(target_dir, "dictionary.bin")
    
    print(f"Writing {max_token_id} tokens to {output_path}...")
    
    with open(output_path, "wb") as f:
        f.write(header)
        f.write(offset_bytes)
        f.write(string_bytes)
        
    # Cleanup old dictionary
    old_json = os.path.join(target_dir, "dictionary.json.gz")
    if os.path.exists(old_json):
        os.remove(old_json)
        
    print(f"Extraction complete. Total bin size: {len(header) + len(offset_bytes) + len(string_bytes)} bytes.")
